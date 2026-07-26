import type { BenchArtifactDefinition, BenchArtifactInput } from "./artifact"
import type { BenchDimensionDefinition, BenchDimensionValue } from "./dimension"
import type { BenchCell } from "./factor"
import type { BenchFactor } from "./factor"
import type { BenchMeasurementDefinition } from "./measurement"
import type { BenchObservationIndex } from "./observation"
import type { BenchResolvedWorkspaceDefinition, BenchWorkspaceDefinition } from "./workspace"

export type BenchNormalizedConfig = Omit<BenchConfig, "factors" | "trials" | "tests" | "measurements" | "dimensions" | "artifacts" | "workspace"> & {
    identity: { name: string; version: string }
    factors: BenchFactor[]
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
    readonly workspace: string
    factor<T = unknown>(id: string): T
    observe(measurementId: string, value: number | boolean | string, options?: BenchObserveOptions): void
    attach(definitionId: string, content: unknown, options?: BenchAttachOptions): Promise<void>
}

/** Published benchmark contract. Native Bun test files define its executable cases. */
export type BenchConfig = {
    description: string
    workspace?: BenchWorkspaceDefinition
    factors?: BenchFactor[]
    /** Repetitions per test × cell. Defaults to one. */
    trials?: number
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
