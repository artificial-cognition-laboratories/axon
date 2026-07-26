import type { EngineRef } from "../engine"
import type { BenchValue } from "./value"

export type BenchFactorKind =
    | "agent"
    | "model"
    | "cognet"
    | "dataset"
    | "toolset"
    | "environment"
    | "judge"
    | "value"

export type BenchFactorRole = "subject" | "control" | "input" | "assessor"

export type BenchFactorValue<T> = {
    /** Stable within the factor; used in cell identities. */
    id: string
    label?: string
    description?: string
    value: T
}

type Factor<K extends BenchFactorKind, T> = {
    id: string
    label: string
    description?: string
    kind: K
    role: BenchFactorRole
    /** One value is a held constant; two or more form a matrix axis. */
    values: BenchFactorValue<T>[]
}

export type BenchFactor =
    | Factor<"agent", { ref: string }>
    | Factor<"model", { engine: EngineRef }>
    | Factor<"cognet", { ref: string }>
    | Factor<"dataset", { ref: string; split?: string }>
    | Factor<"toolset", { refs: string[] }>
    | Factor<"environment", { env: Record<string, string> }>
    | Factor<"judge", { ref: string; rubric?: string }>
    | Factor<"value", BenchValue>

export type BenchFactorSelection = {
    factorId: string
    kind: BenchFactorKind
    valueId: string
}

/** A raw Cartesian coordinate before values are resolved and pinned. */
export type BenchCoordinate = {
    id: string
    factors: BenchFactorSelection[]
}

/** Manifest-safe identity of a selected value. Secret values are never included. */
export type BenchResolvedFactor = BenchFactorSelection & {
    role: BenchFactorRole
    label: string
    /** Immutable registry version, content hash, or canonical value hash. */
    pin: string
}

/** One fully resolved coordinate, including both swept and constant factors. */
export type BenchCell = {
    id: string
    factors: BenchResolvedFactor[]
}

