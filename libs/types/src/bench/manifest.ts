import type { BenchArtifactDefinition } from "./artifact"
import type { BenchDimensionDefinition } from "./dimension"
import type { BenchCaseRef, BenchTestRef } from "./execution"
import type { BenchCell, BenchFactorKind, BenchFactorRole } from "./factor"
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

export type BenchFactorSnapshot = {
    id: string
    label: string
    kind: BenchFactorKind
    role: BenchFactorRole
}

/** Layer-two reproducibility record. A result without this is not comparable. */
export type BenchRunManifest = {
    runId: string
    bench: BenchIdentity
    protocols: BenchProtocolVersions
    schema: BenchSchemaSnapshot
    factors: BenchFactorSnapshot[]
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
