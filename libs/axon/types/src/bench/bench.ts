import type { BenchArtifactDefinition, BenchArtifactInput } from "./artifact"
import type { BenchDimensionDefinition, BenchDimensionValue } from "./dimension"
import type { BenchAxis, BenchCell, BenchMatrix } from "./matrix"
import type { BenchMeasurementDefinition } from "./measurement"
import type { BenchObservationIndex } from "./observation"
import type { BenchResolvedWorkspaceDefinition, BenchWorkspaceDefinition, BenchWorkspaceHandle } from "./workspace"

export type BenchNormalizedConfig = Omit<BenchConfig, "matrix" | "trials" | "tests" | "measurements" | "dimensions" | "artifacts" | "workspace"> & {
    identity: { name: string; version: string; description?: string }
    axes: BenchAxis[]
    trials: number
    tests: string[]
    measurements: BenchMeasurementDefinition[]
    dimensions: BenchDimensionDefinition[]
    artifacts: BenchArtifactDefinition[]
    workspace: BenchResolvedWorkspaceDefinition
}

export type BenchObserveOptions = {
    dimensions?: Record<string, BenchDimensionValue>
    at?: BenchObservationIndex
}

export type BenchAttachOptions = {
    mediaType?: string
    role?: BenchArtifactInput["role"]
    schema?: string
}

/** Public authoring handle. Generated declarations narrow its string IDs and values. */
export type BenchHandle = {
    /**
     * The agent's world for this trial. Stringifies to its path, so it can be
     * passed anywhere a directory is expected, and carries the queries a
     * scenario needs afterward — `changed()` and `diff()` in particular, which
     * a test cannot compute alone because they need the world as it was before
     * the agent booted.
     */
    readonly workspace: BenchWorkspaceHandle
    axis<T = unknown>(key: string): T
    observe(measurementId: string, value: number | boolean | string, options?: BenchObserveOptions): void
    attach(definitionId: string, content: unknown, options?: BenchAttachOptions): Promise<void>
}

/** Published benchmark contract. Native Bun test files define its executable cases. */
export type BenchConfig = {
    workspace?: BenchWorkspaceDefinition
    /**
     * The variations to sweep. Every key is an axis and multiple keys
     * multiply, so one key is the controlled single-variable experiment and
     * more than one is a grid whose size is the author's to manage.
     */
    matrix?: BenchMatrix
    /**
     * Repetitions per test × cell. Defaults to one.
     *
     * Real models are stochastic: a single sample per cell is an anecdote,
     * not a measurement.
     */
    trials?: number
    /**
     * Runs after the workspace is copied and before the subject boots, once
     * per iteration — the point at which the world exists but nothing has
     * touched it yet (install dependencies, seed a database, snapshot a
     * baseline).
     */
    setup?: () => Promise<void> | void
    /** Native Bun test globs. Defaults to benchmark files beneath tests/. */
    tests?: string[]
    measurements?: BenchMeasurementDefinition[]
    dimensions?: BenchDimensionDefinition[]
    artifacts?: BenchArtifactDefinition[]
    budget?: { perTrial?: string; total?: string }
}
export type BenchDefinition = { _kind: "bench"; config: BenchConfig }

/** Ambient author API installed by the bench preload for the active Bun test. */
export type BenchContext = BenchHandle & {
    readonly runId: string
    readonly cell: BenchCell
    readonly trial: number
    readonly attempt: number
    readonly workdir: string
}
