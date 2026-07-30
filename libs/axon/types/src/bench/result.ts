import type { BenchArtifactRef } from "./artifact"
import type { BenchFault, BenchSessionRef, BenchTrialRecord } from "./execution"
import type { BenchRunManifest } from "./manifest"
import type { BenchObservation, BenchMeasurementState } from "./observation"

export type BenchCoverageMissingReason = "skipped" | "filtered" | "cancelled" | "fault" | "not_emitted"

export type BenchCoverage = {
    expectedTrials: number
    executedTrials: number
    completedTrials: number
    expectedMeasurements: number
    observedMeasurements: number
    missing: Partial<Record<BenchCoverageMissingReason, number>>
    /** States are retained for exact audit of required measurements. */
    measurements: BenchMeasurementState[]
}

/**
 * Canonical run data. Aggregates and visualizations are deliberately absent:
 * both are reproducible projections over this immutable record.
 */
export type BenchRunResult = {
    manifest: BenchRunManifest
    trials: BenchTrialRecord[]
    observations: BenchObservation[]
    artifacts: BenchArtifactRef[]
    sessions: BenchSessionRef[]
    faults: BenchFault[]
    coverage: BenchCoverage
}

