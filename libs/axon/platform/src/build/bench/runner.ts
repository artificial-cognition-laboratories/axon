import { join } from "node:path"
import type {
    AxonTestEvent,
    BenchAxis,
    BenchCoordinate,
    BenchCoverage,
    BenchEventMap,
    BenchHash,
    BenchNormalizedConfig,
    BenchRunManifest,
    BenchMeasurementState,
    BenchResourceUsage,
    BenchTestRef,
} from "@arcforge/types"
import { BENCH_PROTOCOL } from "@arcforge/types"
import { err } from "@arcforge/err"
import type { BenchLogT } from "./log"
import type { ResolverT } from "./resolve"
import type { TestRunnerT } from "../../services/test"
import { Workspace } from "./workspace"

export type RunnerOpts = { root: string; log: BenchLogT; resolver: ResolverT; tests: TestRunnerT }

/**
 * Parse a budget string into minor units of USD.
 *
 * Accepts "$0.50", "0.50", "50c". Returns null for undefined so an unset
 * budget is unmistakably "no ceiling" rather than zero — a budget of zero
 * would halt the run before the first trial, which is never what anyone means.
 */
function budgetUsd(value: string | undefined): number | null {
    if (!value) return null
    const trimmed = value.trim()
    const cents = /^(\d+(?:\.\d+)?)\s*c$/i.exec(trimmed)
    if (cents) return Number(cents[1]) / 100
    const dollars = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(trimmed)
    if (dollars) return Number(dollars[1])
    throw err("BENCH_CONFIG_INVALID", { detail: `budget ${JSON.stringify(value)} is not an amount like "$0.50"` })
}

function hash(value: unknown): BenchHash {
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function testRef(event: Extract<AxonTestEvent, { type: "test:case:declare" }>): BenchTestRef {
    return {
        id: event.context.testId!,
        file: event.context.file!,
        suite: event.data.suite,
        name: event.data.name,
    }
}

/** The concrete value selected on each axis, keyed by axis — what the subject is built from. */
function selectedValues(axes: BenchAxis[], coordinate: BenchCoordinate): Record<string, unknown> {
    return Object.fromEntries(coordinate.axes.map(selection => {
        const axis = axes.find(item => item.key === selection.key)
        const value = axis?.values.find(item => item.id === selection.valueId)
        if (!value) {
            throw err("BENCH_AXIS_VALUE_NOT_FOUND", {
                detail: `${selection.key}/${selection.valueId}`,
                context: { axis: selection.key, valueId: selection.valueId },
            })
        }
        return [selection.key, value.value]
    }))
}

function isBenchMessage(value: unknown): value is { channel: "axon:bench"; frame: { type: keyof BenchEventMap; context: Record<string, unknown>; data: unknown } } {
    if (!value || typeof value !== "object") return false
    const message = value as any
    return message.channel === "axon:bench"
        && [
            "bench:observation", "bench:artifact",
            "bench:session:attach", "bench:session:detach", "bench:session:usage",
            "bench:workspace:materialized", "bench:workspace:captured",
            "bench:workspace:retained", "bench:workspace:cleaned",
        ].includes(message.frame?.type)
        && typeof message.frame.context === "object"
}

export function Runner(opts: RunnerOpts) {
    return {
        async run(
            config: BenchNormalizedConfig,
            coordinates: BenchCoordinate[],
            agentPins?: Map<string, string>,
            agentRoots?: Record<string, string>,
        ): Promise<string> {
            const runId = Bun.randomUUIDv7()
            const started = performance.now()
            const preparedWorkspace = await Workspace({ root: opts.root, definition: config.workspace }).prepare()
            const manifest: BenchRunManifest = {
                runId,
                bench: { ref: config.identity.name, name: config.identity.name, version: config.identity.version, hash: hash(config) },
                protocols: BENCH_PROTOCOL,
                schema: {
                    hash: hash({ measurements: config.measurements, dimensions: config.dimensions, artifacts: config.artifacts }),
                    measurements: config.measurements,
                    dimensions: config.dimensions,
                    artifacts: config.artifacts,
                },
                axes: config.axes.map(axis => ({ key: axis.key, label: axis.label ?? axis.key, values: axis.values.map(value => value.id) })),
                cells: [],
                trials: config.trials,
                tests: [],
                cases: [],
                caseSetPin: hash(config.tests),
                harness: { name: "axon", version: "0.1.0", runtime: process.version, bun: Bun.version },
                workspace: preparedWorkspace.template,
                startedAt: new Date().toISOString(),
            }
            const cells = []
            for (const coordinate of coordinates) cells.push(await opts.resolver.resolve(config.axes, coordinate, agentPins))
            manifest.cells = cells
            await opts.log.emit({ benchRunId: runId }, "bench:run:start", { manifest })
            await opts.log.writeManifest(runId, manifest)
            await opts.log.emit({ benchRunId: runId }, "bench:workspace:prepared", { template: preparedWorkspace.template })

            const perTrialBudget = budgetUsd(config.budget?.perTrial)
            const totalBudget = budgetUsd(config.budget?.total)
            let spentUsd = 0
            let budgetExhausted = false

            let expectedTrials = 0
            let executedTrials = 0
            let completedTrials = 0
            let completedCases = 0
            const required = config.measurements.filter(item => item.required).length
            const requiredIds = new Set(config.measurements.filter(item => item.required).map(item => item.id))
            const measured = new Set<string>()
            const measurementStates: BenchMeasurementState[] = []
            const preload = new URL("./preload.ts", import.meta.url).pathname

            try {
                for (let cellIndex = 0; cellIndex < coordinates.length && !budgetExhausted; cellIndex++) {
                    const coordinate = coordinates[cellIndex]!
                    const cell = cells[cellIndex]!
                    const cellStarted = performance.now()
                    await opts.log.emit({ benchRunId: runId, cellId: cell.id }, "bench:cell:start", { cell })
                    // Each level closes its OWN bracket on the way out. The
                    // run-level catch below cannot do it for them: by the time
                    // it runs, which cell and trial were in flight is lost.
                    try {
                    for (let trial = 0; trial < config.trials && !budgetExhausted; trial++) {
                        expectedTrials++
                        const trialStarted = performance.now()
                        const base = { benchRunId: runId, cellId: cell.id, trial }
                        await opts.log.emit(base, "bench:trial:start", {})
                        try {
                        let cases = 0
                        let completed = 0
                        const subject: BenchResourceUsage = { durationMs: 0, tokens: { input: 0, output: 0 }, engineCalls: 0, toolCalls: 0, errors: 0 }
                        let subjectCost = 0
                        let subjectCostKnown = true
                        const context = {
                            runId,
                            cellId: cell.id,
                            trial,
                            axes: cell.axes,
                            axisValues: selectedValues(config.axes, coordinate),
                            measurements: config.measurements,
                            dimensions: config.dimensions,
                            artifacts: config.artifacts,
                            artifactDir: join(opts.log.runDir(runId), "artifacts"),
                            benchRoot: opts.root,
                            // setup() is a function and the context crosses as
                            // JSON — the preload re-imports the config to reach it.
                            configPath: join(opts.root, "bench.config.ts"),
                            agentRoots,
                            workspace: {
                                definition: config.workspace,
                                template: preparedWorkspace.template,
                                sourcePath: preparedWorkspace.sourcePath,
                                root: join(opts.root, ".bench", "workspace"),
                            },
                        }
                        await opts.tests.run({
                            cwd: opts.root,
                            files: config.tests,
                            preloads: [preload],
                            env: { AXON_BENCH_CONTEXT: JSON.stringify(context) },
                            async onMessage(message) {
                                if (!isBenchMessage(message)) return
                                const frame = message.frame
                                const eventContext = { ...base, ...(frame.context as object) }
                                const emitted = await opts.log.emit(eventContext, frame.type, frame.data as never)
                                if (frame.type === "bench:session:usage") {
                                    const usage = (frame.data as { usage: BenchResourceUsage }).usage
                                    subject.durationMs += usage.durationMs
                                    subject.tokens.input += usage.tokens.input
                                    subject.tokens.output += usage.tokens.output
                                    subject.engineCalls += usage.engineCalls
                                    subject.toolCalls += usage.toolCalls
                                    subject.errors += usage.errors
                                    if (usage.costUsd === undefined) subjectCostKnown = false
                                    else subjectCost += usage.costUsd
                                }
                                if (frame.type === "bench:observation") {
                                    const measurementId = (frame.data as { measurementId?: string }).measurementId
                                    if (measurementId && requiredIds.has(measurementId)) {
                                        const slot = `${cell.id}:${trial}:${frame.context.testId ?? ""}:${frame.context.attempt ?? 0}:${measurementId}`
                                        if (!measured.has(slot)) {
                                            measured.add(slot)
                                            measurementStates.push({ kind: "observed", observationId: String(emitted.time.seq) })
                                        }
                                    }
                                }
                            },
                            async onEvent(event) {
                                const eventContext = { ...base, testId: event.context.testId, attempt: event.context.attempt }
                                if (event.type === "test:case:declare") {
                                    cases++
                                    await opts.log.emit(eventContext, "bench:case:declare", { test: testRef(event) })
                                } else if (event.type === "test:case:pass" || event.type === "test:case:fail") {
                                    completed++
                                    completedCases++
                                    for (const measurementId of requiredIds) {
                                        const slot = `${cell.id}:${trial}:${event.context.testId ?? ""}:${event.context.attempt ?? 0}:${measurementId}`
                                        if (!measured.has(slot)) measurementStates.push({ kind: "missing", reason: "not_emitted" })
                                    }
                                    await opts.log.emit(eventContext, "bench:case:complete", {
                                        status: event.type === "test:case:pass" ? "passed" : "failed",
                                        durationMs: event.data.durationMs,
                                        ...(event.type === "test:case:fail" ? { error: event.data.error } : {}),
                                    })
                                } else if (event.type === "test:case:skip" || event.type === "test:case:todo") {
                                    completed++
                                    completedCases++
                                    for (const _measurementId of requiredIds) measurementStates.push({ kind: "missing", reason: "filtered" })
                                    await opts.log.emit(eventContext, "bench:case:complete", {
                                        status: event.type === "test:case:skip" ? "skipped" : "todo",
                                        durationMs: 0,
                                    })
                                }
                            },
                        })
                        if (cases === 0) throw err("BENCH_NO_CASES")
                        executedTrials++
                        if (completed === cases) completedTrials++

                        // Budget is checked AFTER the trial, not during: a trial
                        // is the smallest unit whose cost is knowable, and killing
                        // one mid-flight would leave a half-run that measures
                        // nothing while still having been paid for. Exceeding the
                        // ceiling is a fault, so the trial is excluded from scoring
                        // rather than counted as a failure of the agent.
                        if (subjectCostKnown) {
                            spentUsd += subjectCost
                            if (perTrialBudget !== null && subjectCost > perTrialBudget) {
                                await opts.log.emit(base, "bench:process:fault", {
                                    fault: { code: "budget", message: `trial spent $${subjectCost.toFixed(4)}, over the $${perTrialBudget} per-trial budget`, context: { runId, cellId: cell.id, trial } },
                                })
                            }
                            if (totalBudget !== null && spentUsd > totalBudget) {
                                await opts.log.emit(base, "bench:process:fault", {
                                    fault: { code: "budget", message: `run spent $${spentUsd.toFixed(4)}, over the $${totalBudget} total budget — stopping`, context: { runId, cellId: cell.id, trial } },
                                })
                                budgetExhausted = true
                            }
                        }

                        await opts.log.emit(base, "bench:trial:complete", {
                            durationMs: performance.now() - trialStarted,
                            physics: {
                                subject: { ...subject, ...(subjectCostKnown ? { costUsd: subjectCost } : {}) },
                                harness: { durationMs: performance.now() - trialStarted },
                            },
                        })
                        } catch (error) {
                            await opts.log.emit(base, "bench:trial:failed", {
                                durationMs: performance.now() - trialStarted,
                                error: err(error),
                            })
                            throw error
                        }
                    }
                    await opts.log.emit({ benchRunId: runId, cellId: cell.id }, "bench:cell:complete", { durationMs: performance.now() - cellStarted })
                    } catch (error) {
                        await opts.log.emit({ benchRunId: runId, cellId: cell.id }, "bench:cell:failed", {
                            durationMs: performance.now() - cellStarted,
                            error: err(error),
                        })
                        throw error
                    }
                }
                const coverage: BenchCoverage = {
                    expectedTrials,
                    executedTrials,
                    completedTrials,
                    expectedMeasurements: completedCases * required,
                    observedMeasurements: measured.size,
                    missing: completedCases * required > measured.size
                        ? { not_emitted: measurementStates.filter(item => item.kind === "missing" && item.reason === "not_emitted").length,
                            filtered: measurementStates.filter(item => item.kind === "missing" && item.reason === "filtered").length }
                        : {},
                    measurements: measurementStates,
                }
                await opts.log.emit({ benchRunId: runId }, "bench:run:complete", { durationMs: performance.now() - started, coverage })
                return runId
            } catch (error) {
                await opts.log.emit({ benchRunId: runId }, "bench:run:failed", { error: err(error) })
                throw error
            }
        },
    }
}

export type RunnerT = ReturnType<typeof Runner>
