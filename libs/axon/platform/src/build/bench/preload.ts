import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { isAbsolute, resolve } from "node:path"
import { Axon as createAxon } from "@arcforge/core"
import { err } from "@arcforge/err"
import { Blueprint } from "../blueprint/blueprint"
import {
    materializeWorkspace,
    WorkspaceHandle,
    removeWorkspace,
    snapshotWorkspace,
    workspaceChanges,
    type WorkspaceSnapshot,
} from "./workspace"
import type {
    ProviderEntry,
    BenchArtifactRef,
    BenchDimensionDefinition,
    BenchExecutionContext,
    BenchHandle,
    BenchMeasurementDefinition,
    BenchObservationPayload,
    BenchAxisKey,
    BenchResolvedAxis,
    BenchResolvedWorkspaceDefinition,
    BenchTestStatus,
    BenchWorkspaceInstance,
    BenchWorkspaceTemplate,
} from "@arcforge/types"

type TestContext = { testId?: string; attempt?: number; resources?: Record<string, unknown> }
type TestOutcome = { status: "passed" } | { status: "failed"; error: unknown }
type ActiveWorkspace = { instance: BenchWorkspaceInstance; before: WorkspaceSnapshot }
type RuntimeContext = {
    runId: string
    cellId: string
    trial: number
    axes: BenchResolvedAxis[]
    axisValues: Record<string, unknown>
    measurements: BenchMeasurementDefinition[]
    dimensions: BenchDimensionDefinition[]
    artifacts: Array<{ id: string; role?: BenchArtifactRef["role"]; mediaTypes?: string[]; schema?: string }>
    artifactDir: string
    benchRoot: string
    workspace: {
        definition: BenchResolvedWorkspaceDefinition
        template: BenchWorkspaceTemplate
        sourcePath?: string
        root: string
    }
    /** Absolute path to bench.config.ts — setup() is a function, so it cannot cross the IPC boundary. */
    configPath?: string
    /** Prepared agent roots, keyed by the ref as written in the matrix. */
    agentRoots?: Record<string, string>
}

const encoded = process.env.AXON_BENCH_CONTEXT
if (!encoded) throw err("BENCH_CONTEXT_MISSING")
const runtime = JSON.parse(encoded) as RuntimeContext

function active(): TestContext {
    const bridge = (globalThis as any).__axon_test_context__ as { current?: () => TestContext | undefined } | undefined
    const current = bridge?.current?.()
    if (!current?.testId) throw err("BENCH_NO_ACTIVE_CASE")
    return current
}

function execution(current = active()): BenchExecutionContext {
    return { runId: runtime.runId, cellId: runtime.cellId, testId: current.testId, trial: runtime.trial, attempt: current.attempt ?? 0 }
}

function workspaceResource(current = active()): ActiveWorkspace {
    const workspace = current.resources?.workspace as ActiveWorkspace | undefined
    if (!workspace) throw err("BENCH_WORKSPACE_UNAVAILABLE")
    return workspace
}

function pathSegment(value: string | number): string {
    return new Bun.CryptoHasher("sha256").update(String(value)).digest("hex").slice(0, 16)
}

function send(type: string, data: unknown, current = active()): void {
    const ipc = process as typeof process & { send?: (message: unknown) => void }
    ipc.send?.({ channel: "axon:bench", frame: { type, context: execution(current), data } })
}

/** The variation selected on one axis for this cell, or undefined if the axis is not in the matrix. */
function selected(key: BenchAxisKey): unknown {
    return runtime.axisValues[key]
}

function resourceUsage(kernelLog: Array<{ type: string; data: any }>, durationMs: number) {
    const completed = kernelLog.filter(event => event.type === "kernel:engine:complete")
    const priced = completed.every(event => event.data.meta.cost?.total !== undefined)
    return {
        durationMs,
        tokens: {
            input: completed.reduce((sum, event) => sum + (event.data.meta.tokens?.in ?? 0), 0),
            output: completed.reduce((sum, event) => sum + (event.data.meta.tokens?.out ?? 0), 0),
        },
        ...(priced ? { costUsd: completed.reduce((sum, event) => sum + event.data.meta.cost.total, 0) } : {}),
        engineCalls: completed.length,
        // Every reach for the world goes through kernel.run() — the capsule is
        // the only door. Counting completions rather than starts means a run
        // the kernel refused is an error, not a tool call.
        toolCalls: kernelLog.filter(event => event.type === "kernel:run:complete").length,
        errors: kernelLog.filter(event => event.type === "kernel:engine:failed" || event.type === "kernel:run:failed").length,
    }
}

/**
 * Invoke the config's setup() for this iteration.
 *
 * Loaded from disk here rather than passed in: the runtime context crosses to
 * this process as JSON, and a function does not survive that. Importing the
 * config in the preload is the same module the runner already validated, so
 * there is no second source of truth — only a second reader.
 */
let preparingWorkspace: string | null = null
let setupHook: ((workspace: string) => Promise<void> | void) | null | undefined
async function runSetup(workspace: string): Promise<void> {
    if (setupHook === undefined) {
        if (!runtime.configPath) {
            setupHook = null
        } else {
            // bench.config.ts calls defineBench at module scope, and in this
            // process that global does not exist — importing without it throws
            // a ReferenceError that surfaces as an unexplained trial failure.
            // Install it for the duration of the import only.
            const globals = globalThis as typeof globalThis & { defineBench?: unknown }
            const previous = globals.defineBench
            globals.defineBench = (config: unknown) => ({ _kind: "bench", config })
            try {
                const loaded = (await import(runtime.configPath)) as { default?: { config?: { setup?: () => Promise<void> | void } } }
                const declared = loaded.default?.config?.setup
                setupHook = declared ? async () => { await declared() } : null
            } finally {
                if (previous) globals.defineBench = previous
                else delete globals.defineBench
            }
        }
    }
    if (!setupHook) return

    preparingWorkspace = workspace
    try {
        await setupHook(workspace)
    } finally {
        preparingWorkspace = null
    }
}

async function bootSubject() {
    const current = active()
    // Each named axis is a binding point in the assembled blueprint. `agent`
    // decides WHICH blueprint is loaded, so it resolves first; `cognet` edits
    // the agent's source before load; the rest merge onto the loaded config.
    // A variation is a path or a registry ref. Registry refs were fetched into
    // .bench/agents/ during prepare, so resolution here is a lookup rather than
    // a second fetch — the run must not reach the network.
    const agent = selected("agent") as string | undefined
    const agentRoot = agent
        ? (runtime.agentRoots?.[agent] ?? (isAbsolute(agent) ? agent : resolve(runtime.benchRoot, agent)))
        : runtime.benchRoot
    if (!await Bun.file(join(agentRoot, "axon.config.ts")).exists()) {
        throw err("BENCH_AGENT_UNRESOLVED", { detail: `${agent ?? agentRoot} is not a prepared local agent`, context: { agentRoot, ref: agent } })
    }
    const blueprintHandle = Blueprint({ root: agentRoot })
    // A bench's `cognet` axis names a path on disk, not an installed package:
    // the point is running an agent against a brain it does not declare.
    const cognet = selected("cognet") as string | undefined
    if (cognet) {
        await blueprintHandle.cognet.compile({
            kind: "source",
            dir: isAbsolute(cognet) ? cognet : resolve(runtime.benchRoot, cognet),
        })
    }
    const loaded = await blueprintHandle.load({ compile: !cognet })
    /**
     * The `model` axis, in either form the inference model allows.
     *
     * A STRING is a cortex pin (`"codex:gpt-5.6-terra"`) and lands on
     * `config.model`. A PROVIDER ENTRY is a source (`Ollama({ url })`) and
     * lands on `config.providers`, REPLACING what the agent declared for the
     * duration of this cell — a bench varying inference has to replace rather
     * than append, or every cell resolves against the first provider that can
     * answer and the axis does nothing.
     *
     * `profileProviders` is cleared alongside for the same reason: profile
     * entries rank ahead of an agent's, so leaving them would let the runner's
     * own machine decide what every cell actually ran on.
     *
     * This previously wrote `config.engine`, a field nothing reads — so every
     * cell of a model matrix silently ran on the SAME inference while the
     * manifest recorded them as different.
     */
    const model = selected("model") as string | ProviderEntry | undefined
    const env = selected("env") as Record<string, string> | undefined
    const inference = model === undefined
        ? {}
        : typeof model === "string"
            ? { config: { ...loaded.blueprint.config, model } }
            : { config: { ...loaded.blueprint.config, providers: [model] }, profileProviders: [] }
    const blueprint = {
        ...loaded.blueprint,
        ...inference,
        ...(env ? { env: { ...loaded.blueprint.env, ...env } } : {}),
        paths: {
            root: workspaceResource(current).instance.path,
            data: join(workspaceResource(current).instance.path, ".axon", "data"),
        },
    }
    const started = performance.now()
    const instance = await createAxon({ blueprint })
    const session = {
        agentId: instance.blueprint.agent.name,
        sessionId: instance.blueprint.session.id,
        role: "subject" as const,
    }
    send("bench:session:attach", { session }, current)
    let stopped = false
    const stop = async () => {
        if (stopped) return
        stopped = true
        await instance.shutdown()
        send("bench:session:usage", { session, usage: resourceUsage(instance.session.kernelLog as any[], performance.now() - started) }, current)
        send("bench:session:detach", { session }, current)
    }
    return Object.assign(instance, { stop })
}

function observation(measurementId: string, raw: number | boolean | string, options?: Parameters<BenchHandle["observe"]>[2]): BenchObservationPayload {
    const definition = runtime.measurements.find(item => item.id === measurementId)
    if (!definition) throw err("BENCH_MEASUREMENT_UNKNOWN", { context: { measurementId } })
    if (definition.value.kind === "number" && typeof raw !== "number") throw err("BENCH_MEASUREMENT_TYPE", { detail: `${measurementId} expects number`, context: { measurementId } })
    if (definition.value.kind === "boolean" && typeof raw !== "boolean") throw err("BENCH_MEASUREMENT_TYPE", { detail: `${measurementId} expects boolean`, context: { measurementId } })
    if ((definition.value.kind === "category" || definition.value.kind === "text") && typeof raw !== "string") throw err("BENCH_MEASUREMENT_TYPE", { detail: `${measurementId} expects string`, context: { measurementId } })
    if (definition.value.kind === "number" && definition.value.domain) {
        if (definition.value.domain.min !== undefined && (raw as number) < definition.value.domain.min) throw err("BENCH_MEASUREMENT_DOMAIN", { detail: `${measurementId} is below minimum`, context: { measurementId } })
        if (definition.value.domain.max !== undefined && (raw as number) > definition.value.domain.max) throw err("BENCH_MEASUREMENT_DOMAIN", { detail: `${measurementId} is above maximum`, context: { measurementId } })
    }
    if (definition.value.kind === "category" && definition.value.values && !definition.value.open && !definition.value.values.includes(raw as string)) {
        throw err("BENCH_MEASUREMENT_DOMAIN", { detail: `${measurementId} has unknown category ${JSON.stringify(raw)}`, context: { measurementId } })
    }
    for (const [id, value] of Object.entries(options?.dimensions ?? {})) {
        const dimension = runtime.dimensions.find(item => item.id === id)
        if (!dimension) throw err("BENCH_DIMENSION_UNKNOWN", { context: { dimensionId: id } })
        if (dimension.value.kind === "category" && !dimension.value.open && !dimension.value.values.includes(String(value))) {
            throw err("BENCH_DIMENSION_DOMAIN", { detail: `${id} has unknown category ${JSON.stringify(value)}`, context: { dimensionId: id } })
        }
    }
    const value = definition.value.kind === "number"
        ? { kind: "number" as const, value: raw as number }
        : definition.value.kind === "boolean"
            ? { kind: "boolean" as const, value: raw as boolean }
            : definition.value.kind === "category"
                ? { kind: "category" as const, value: raw as string }
                : { kind: "text" as const, value: raw as string }
    return { measurementId, value, dimensions: options?.dimensions, index: options?.at, producer: { kind: "benchmark", sourceHash: "runtime" } }
}

const bench: BenchHandle = {
    get workspace() {
        // During setup() the workspace exists on disk but its resource is not
        // registered yet (the baseline snapshot has not been taken, because
        // setup is what it must be taken AFTER). Fall back to a handle over the
        // path being prepared so a setup hook can address the world it is
        // setting up — with an empty baseline, since nothing has changed yet.
        if (preparingWorkspace) {
            return WorkspaceHandle({
                path: preparingWorkspace,
                before: new Map(),
                ignore: runtime.workspace.definition.capture.ignore,
            })
        }
        const resource = workspaceResource()
        return WorkspaceHandle({
            path: resource.instance.path,
            before: resource.before,
            ignore: runtime.workspace.definition.capture.ignore,
        })
    },
    // BenchHandle declares axis<T>(key): T so generated per-bench declarations
    // can narrow the return. The runtime map is untyped by nature, so the cast
    // to the caller's T happens here, once, at that seam — after the key has
    // been validated against the manifest.
    axis<T = unknown>(key: string): T {
        if (!(key in runtime.axisValues)) throw err("BENCH_AXIS_UNKNOWN", { context: { axis: key } })
        return runtime.axisValues[key] as T
    },
    observe(id, value, options) {
        send("bench:observation", observation(id, value, options))
    },
    async attach(id, content, options = {}) {
        const definition = runtime.artifacts.find(item => item.id === id)
        if (!definition) throw err("BENCH_ARTIFACT_UNKNOWN", { context: { artifactId: id } })
        const mediaType = options.mediaType ?? definition.mediaTypes?.[0] ?? "application/json"
        if (definition.mediaTypes?.length && !definition.mediaTypes.includes(mediaType)) {
            throw err("BENCH_ARTIFACT_MEDIA_TYPE", { detail: `${id} does not allow ${mediaType}`, context: { artifactId: id, mediaType } })
        }
        const bytes = content instanceof Uint8Array
            ? content
            : typeof content === "string"
                ? new TextEncoder().encode(content)
                : new TextEncoder().encode(JSON.stringify(content))
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        const artifactId = Bun.randomUUIDv7()
        await mkdir(runtime.artifactDir, { recursive: true })
        const path = join(runtime.artifactDir, digest)
        await Bun.write(path, bytes)
        const artifact: BenchArtifactRef = {
            id: artifactId,
            definitionId: id,
            role: options.role ?? definition.role ?? "evidence",
            mediaType,
            schema: options.schema ?? definition.schema,
            hash: `sha256:${digest}`,
            bytes: bytes.byteLength,
            ref: `artifacts/${digest}`,
            context: execution(),
            createdAt: new Date().toISOString(),
        }
        send("bench:artifact", { artifact })
    },
}

async function persistWorkspaceArtifact(current: TestContext, result: unknown): Promise<BenchArtifactRef> {
    const content = new TextEncoder().encode(JSON.stringify(result))
    const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex")
    await mkdir(runtime.artifactDir, { recursive: true })
    await Bun.write(join(runtime.artifactDir, digest), content)
    return {
        id: Bun.randomUUIDv7(),
        definitionId: "axon.workspace.changes",
        role: "output",
        owner: "framework",
        display: runtime.workspace.definition.capture.display,
        mediaType: "application/vnd.axon.workspace-changes+json",
        hash: `sha256:${digest}`,
        bytes: content.byteLength,
        ref: `artifacts/${digest}`,
        context: execution(current),
        createdAt: new Date().toISOString(),
    }
}

const lifecycle = (globalThis as any).__axon_test_context__ as {
    beforeCase(handler: (context: TestContext) => void | Promise<void>): () => void
    afterCase(handler: (context: TestContext, outcome: TestOutcome) => void | Promise<void>): () => void
}

lifecycle.beforeCase(async current => {
    const context = execution(current)
    const destination = join(
        runtime.workspace.root,
        pathSegment(runtime.runId),
        pathSegment(runtime.cellId),
        String(runtime.trial),
        pathSegment(current.testId!),
        String(current.attempt ?? 0),
    )
    try {
        await materializeWorkspace(runtime.workspace.sourcePath, destination, runtime.workspace.definition.capture.ignore)

        // setup() runs BEFORE the baseline snapshot, not after. Installing
        // dependencies or seeding data is preparing the world, not the agent
        // acting on it — snapshotting first would attribute every file setup
        // created to the subject and make workspace.changed() meaningless.
        await runSetup(destination)

        const before = await snapshotWorkspace(destination, {
            ignore: runtime.workspace.definition.capture.ignore,
            persistDir: runtime.artifactDir,
            maxBytes: runtime.workspace.definition.capture.maxBytes,
        })
        const instance: BenchWorkspaceInstance = {
            id: Bun.randomUUIDv7(),
            path: destination,
            context,
            template: runtime.workspace.template,
        }
        current.resources ??= {}
        current.resources.workspace = { instance, before: before.files } satisfies ActiveWorkspace
    } catch (error) {
        await removeWorkspace(destination)
        throw error
    }
    const instance = workspaceResource(current).instance
    send("bench:workspace:materialized", {
        workspaceId: instance.id,
        templateHash: instance.template.hash,
    }, current)
})

lifecycle.afterCase(async (current, outcome) => {
    const activeWorkspace = current.resources?.workspace as ActiveWorkspace | undefined
    if (!activeWorkspace) return
    const definition = runtime.workspace.definition
    const after = await snapshotWorkspace(activeWorkspace.instance.path, {
        ignore: definition.capture.ignore,
        persistDir: runtime.artifactDir,
        maxBytes: definition.capture.maxBytes,
    })
    const changes = definition.capture.changes ? workspaceChanges(activeWorkspace.before, after.files) : []
    const status: BenchTestStatus = outcome.status === "passed" ? "passed" : "failed"
    const retain = definition.retain === "always" || (definition.retain === "failed" && status === "failed")
    const result = {
        workspaceId: activeWorkspace.instance.id,
        templateHash: activeWorkspace.instance.template.hash,
        retained: retain,
        outcome: status,
        changes,
        summary: {
            added: changes.filter(change => change.kind === "added").length,
            modified: changes.filter(change => change.kind === "modified").length,
            deleted: changes.filter(change => change.kind === "deleted").length,
            bytesChanged: changes.reduce((sum, change) => sum + Math.max(change.before?.bytes ?? 0, change.after?.bytes ?? 0), 0),
        },
    }
    send("bench:workspace:captured", { result }, current)
    send("bench:artifact", { artifact: await persistWorkspaceArtifact(current, result) }, current)
    if (retain) {
        send("bench:workspace:retained", {
            workspaceId: activeWorkspace.instance.id,
            reason: definition.retain === "always" ? "always" : "failed",
        }, current)
    } else {
        await removeWorkspace(activeWorkspace.instance.path)
        send("bench:workspace:cleaned", { workspaceId: activeWorkspace.instance.id }, current)
    }
})

;(globalThis as any).bench = bench
;(globalThis as any).Axon = bootSubject

// `observe` is bare rather than only bench.observe: recording a measurement is
// the single thing every scenario does, and it reads alongside expect/it as a
// peer verb rather than a method on a harness object. bench.* keeps the rarer
// surface (axis, attach, workspace).
;(globalThis as any).observe = bench.observe.bind(bench)
