import type { BenchCell } from "./factor"
import type { BenchMeasurementWeighting } from "./measurement"

export type BenchConfidenceInterval = {
    level: number
    low: number
    high: number
    method: string
}

export type BenchNumericSummary = {
    kind: "number"
    samples: number
    mean: number
    median: number
    standardDeviation: number
    min: number
    max: number
    percentiles: Record<string, number>
    confidence?: BenchConfidenceInterval
}

export type BenchBooleanSummary = {
    kind: "boolean"
    samples: number
    true: number
    false: number
    rate: number
    confidence?: BenchConfidenceInterval
}

export type BenchCategorySummary = {
    kind: "category"
    samples: number
    counts: Record<string, number>
    proportions: Record<string, number>
}

export type BenchTextSummary = { kind: "text"; samples: number }
export type BenchMeasurementSummary =
    | BenchNumericSummary
    | BenchBooleanSummary
    | BenchCategorySummary
    | BenchTextSummary

export type BenchAggregateScope = {
    cell?: BenchCell
    testId?: string
    caseId?: string
}

/** Derived projection over one run or a compatible collective cohort. */
export type BenchAggregate = {
    scope: BenchAggregateScope
    weighting: BenchMeasurementWeighting
    runs: number
    contributors: number
    trials: number
    outcomes: { passed: number; failed: number; skipped: number; todo: number }
    measurements: Record<string, BenchMeasurementSummary>
    physics: {
        meanDurationMs: number
        totalCostUsd?: number
        meanCostUsd?: number
    }
}

