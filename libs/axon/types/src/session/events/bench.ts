import type { BenchArtifactRef } from "../../bench/artifact"
import type { BenchFault, BenchPhysics, BenchResourceUsage, BenchSessionRef, BenchTestRef, BenchTestStatus } from "../../bench/execution"
import type { BenchCell } from "../../bench/matrix"
import type { BenchRunManifest } from "../../bench/manifest"
import type { BenchObservationPayload } from "../../bench/observation"
import type { BenchCoverage } from "../../bench/result"
import type { BenchWorkspaceResult, BenchWorkspaceTemplate } from "../../bench/workspace"
import type { BenchHash } from "../../bench/value"
import type { AxonError } from "../../error"
import type { AxonEventUnion } from "../envelope"

/** Correlation for the bench-run log. It never pretends to be an agent session. */
export type BenchEventContext = {
    benchRunId: string
    cellId?: string
    trial?: number
    testId?: string
    caseId?: string
    attempt?: number
}

export type BenchEventMap = {
    "bench:run:start": { manifest: BenchRunManifest }
    "bench:run:complete": { durationMs: number; coverage: BenchCoverage }
    "bench:run:failed": { error: AxonError }

    // A cell or trial that throws mid-loop must still close its bracket.
    // Without these the run's own :failed was the only record, leaving
    // cell/trial :start events permanently open — and the projection, which
    // reads :complete alone, silently dropped the crashed work rather than
    // reporting it as incomplete.
    "bench:cell:start": { cell: BenchCell }
    "bench:cell:complete": { durationMs: number }
    "bench:cell:failed": { durationMs: number; error: AxonError }

    "bench:trial:start": Record<string, never>
    "bench:trial:complete": { durationMs: number; physics: BenchPhysics }
    "bench:trial:failed": { durationMs: number; error: AxonError }

    "bench:case:declare": { test: BenchTestRef }
    "bench:case:complete": { status: BenchTestStatus; durationMs: number; error?: AxonError }

    "bench:session:attach": { session: BenchSessionRef }
    "bench:session:detach": { session: BenchSessionRef }
    "bench:session:usage": { session: BenchSessionRef; usage: BenchResourceUsage }
    "bench:observation": BenchObservationPayload
    "bench:artifact": { artifact: BenchArtifactRef }
    "bench:workspace:prepared": { template: BenchWorkspaceTemplate }
    "bench:workspace:materialized": { workspaceId: string; templateHash: BenchHash }
    "bench:workspace:captured": { result: BenchWorkspaceResult }
    "bench:workspace:retained": { workspaceId: string; reason: "failed" | "always" }
    "bench:workspace:cleaned": { workspaceId: string }
    "bench:process:fault": { fault: BenchFault }
}

export type BenchEvent = AxonEventUnion<BenchEventMap, BenchEventContext>
