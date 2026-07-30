import type { BenchArtifactDefinition } from "./artifact"
import type { BenchDimensionDefinition } from "./dimension"
import type { BenchCaseRef, BenchTestRef } from "./execution"
import type { BenchAxisKey, BenchCell } from "./matrix"
import type { BenchMeasurementDefinition } from "./measurement"
import type { BenchHarnessIdentity, BenchProtocolVersions } from "./protocol"
import type { BenchHash } from "./value"
import type { BenchWorkspaceTemplate } from "./workspace"

export type BenchIdentity = {
    ref: string
    name: string
    version: string
    hash: BenchHash
}

export type BenchSchemaSnapshot = {
    hash: BenchHash
    measurements: BenchMeasurementDefinition[]
    dimensions: BenchDimensionDefinition[]
    artifacts: BenchArtifactDefinition[]
}

export type BenchAxisSnapshot = {
    key: BenchAxisKey
    label: string
    /** Variation ids on this axis, in declared order. */
    values: string[]
}

/** Layer-two reproducibility record. A result without this is not comparable. */
export type BenchRunManifest = {
    runId: string
    bench: BenchIdentity
    protocols: BenchProtocolVersions
    schema: BenchSchemaSnapshot
    axes: BenchAxisSnapshot[]
    cells: BenchCell[]
    trials: number
    tests: BenchTestRef[]
    cases: BenchCaseRef[]
    /** Pins discovery and filtering of the case set independently of source. */
    caseSetPin: BenchHash
    harness: BenchHarnessIdentity
    workspace: BenchWorkspaceTemplate
    startedAt: string
    completedAt?: string
    runner?: { id: string; environment?: string }
}
