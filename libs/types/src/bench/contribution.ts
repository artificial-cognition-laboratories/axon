import type { BenchAggregate } from "./aggregate"
import type { BenchResolvedFactor } from "./factor"
import type { BenchRunResult } from "./result"
import type { BenchHash } from "./value"

export type BenchResultTier = "reported" | "auditable" | "verified"

/** Exact comparability boundary used before results enter a shared aggregate. */
export type BenchCohortKey = {
    benchHash: BenchHash
    schemaHash: BenchHash
    caseSetPin: BenchHash
    controlledFactors: BenchResolvedFactor[]
    harnessCompatibility: string
}

export type BenchSubmission = {
    id: string
    tier: BenchResultTier
    contributor: { id: string }
    result: BenchRunResult
    hashes: { manifest: BenchHash; observations: BenchHash; result: BenchHash }
    signature?: { algorithm: string; keyId: string; value: string }
    submittedAt: string
}

export type BenchSubmissionInclusion =
    | { status: "accepted"; cohortId: string }
    | { status: "excluded"; reasons: string[] }
    | { status: "quarantined"; reasons: string[] }

export type BenchCollectiveAggregate = {
    id: string
    cohort: BenchCohortKey
    tier: BenchResultTier
    submissions: { accepted: number; excluded: number; contributors: number }
    aggregates: BenchAggregate[]
    generatedAt: string
}

