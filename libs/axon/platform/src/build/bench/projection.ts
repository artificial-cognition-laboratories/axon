import type {
    BenchArtifactRef,
    BenchCaseRef,
    BenchConfig,
    BenchCoverage,
    BenchEvent,
    BenchFault,
    BenchObservation,
    BenchPhysics,
    BenchRunResult,
    BenchSessionRef,
    BenchTestRef,
    BenchTrialRecord,
} from "@arcforge/types"
import { err } from "@arcforge/err"

const emptyPhysics = (): BenchPhysics => ({
    subject: { durationMs: 0, tokens: { input: 0, output: 0 }, engineCalls: 0, toolCalls: 0, errors: 0 },
    harness: { durationMs: 0 },
})

function key(context: BenchEvent["context"]): string {
    return `${context.cellId ?? ""}:${context.trial ?? 0}:${context.testId ?? ""}:${context.attempt ?? 0}`
}

/** Pure fold from the immutable JSONL source of truth into portable run data. */
export function Projection() {
    return {
        build(_config: BenchConfig, events: BenchEvent[]): BenchRunResult {
            const start = events.find(event => event.type === "bench:run:start")
            if (!start || start.type !== "bench:run:start") throw err("BENCH_LOG_INVALID", { detail: "missing bench:run:start" })
            const manifest = structuredClone(start.data.manifest)
            const observations: BenchObservation[] = []
            const artifacts: BenchArtifactRef[] = []
            const sessions: BenchSessionRef[] = []
            const faults: BenchFault[] = []
            const tests = new Map<string, BenchTestRef>()
            const physics = new Map<string, BenchPhysics>()
            const observationIds = new Map<string, string[]>()
            const artifactIds = new Map<string, string[]>()
            const trials: BenchTrialRecord[] = []
            let coverage: BenchCoverage = {
                expectedTrials: 0, executedTrials: 0, completedTrials: 0,
                expectedMeasurements: 0, observedMeasurements: 0,
                missing: {}, measurements: [],
            }

            for (const event of events) {
                const eventKey = key(event.context)
                if (event.type === "bench:case:declare") tests.set(event.data.test.id, event.data.test)
                if (event.type === "bench:observation") {
                    // `seq` is the event's identity — see AxonEvent. Unique
                    // within one bench log, which is the scope these ids are
                    // correlated in.
                    const id = String(event.time.seq)
                    observations.push({
                        ...event.data,
                        id,
                        time: new Date(event.time.ms).toISOString(),
                        context: {
                            runId: event.context.benchRunId,
                            cellId: event.context.cellId!,
                            testId: event.context.testId,
                            caseId: event.context.caseId,
                            trial: event.context.trial,
                            attempt: event.context.attempt,
                        },
                    })
                    observationIds.set(eventKey, [...(observationIds.get(eventKey) ?? []), id])
                }
                if (event.type === "bench:artifact") {
                    artifacts.push(event.data.artifact)
                    artifactIds.set(eventKey, [...(artifactIds.get(eventKey) ?? []), event.data.artifact.id])
                }
                if (event.type === "bench:session:attach") sessions.push(event.data.session)
                if (event.type === "bench:process:fault") faults.push(event.data.fault)
                if (event.type === "bench:trial:complete") {
                    physics.set(`${event.context.cellId}:${event.context.trial}`, event.data.physics)
                }
                if (event.type === "bench:case:complete") {
                    const test = tests.get(event.context.testId ?? "")
                    const cell = manifest.cells.find(item => item.id === event.context.cellId)
                    if (!test || !cell) throw err("BENCH_LOG_INVALID", { detail: "case completion has no declaration or cell" })
                    trials.push({
                        id: String(event.time.seq),
                        test,
                        cell,
                        trial: event.context.trial ?? 0,
                        attempt: event.context.attempt ?? 0,
                        status: event.data.status,
                        ...(event.data.error ? { error: event.data.error } : {}),
                        physics: physics.get(`${cell.id}:${event.context.trial}`) ?? emptyPhysics(),
                        sessions: [],
                        observationIds: observationIds.get(eventKey) ?? [],
                        artifactIds: artifactIds.get(eventKey) ?? [],
                    })
                }
                if (event.type === "bench:run:complete") {
                    coverage = event.data.coverage
                    manifest.completedAt = new Date(event.time.ms).toISOString()
                }
            }

            manifest.tests = [...tests.values()]
            manifest.cases = manifest.tests.map(test => ({ id: test.id, testId: test.id, label: test.name } satisfies BenchCaseRef))
            for (const trial of trials) trial.physics = physics.get(`${trial.cell.id}:${trial.trial}`) ?? trial.physics
            return { manifest, trials, observations, artifacts, sessions, faults, coverage }
        },
    }
}

export type ProjectionT = ReturnType<typeof Projection>
