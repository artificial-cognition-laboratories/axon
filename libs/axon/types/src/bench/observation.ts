import type { BenchDimensionValue } from "./dimension"
import type { BenchExecutionContext } from "./execution"

export type BenchObservedValue =
    | { kind: "number"; value: number }
    | { kind: "boolean"; value: boolean }
    | { kind: "category"; value: string }
    | { kind: "text"; value: string }

export type BenchObservationIndex = {
    step?: number
    elapsedMs?: number
    timestamp?: string
}

export type BenchObservationProducer =
    | { kind: "harness" }
    | { kind: "benchmark"; sourceHash: string }
    | { kind: "session"; sessionId: string }
    | { kind: "judge"; ref: string; pin: string; sessionId?: string }

export type BenchObservationPayload = {
    measurementId: string
    value: BenchObservedValue
    dimensions?: Record<string, BenchDimensionValue>
    index?: BenchObservationIndex
    producer: BenchObservationProducer
}

/** Immutable, long-form measurement — the canonical analytical record. */
export type BenchObservation = BenchObservationPayload & {
    id: string
    time: string
    context: BenchExecutionContext
}

export type BenchMissingReason = "not_emitted" | "fault" | "cancelled" | "filtered"
export type BenchMeasurementState =
    | { kind: "observed"; observationId: string }
    | { kind: "missing"; reason: BenchMissingReason }
    | { kind: "invalid"; reason: string; observationId?: string }

