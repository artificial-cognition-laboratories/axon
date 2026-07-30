import type { EngineRef } from "../engine"
import type { BenchValue } from "./value"

/**
 * The named binding points a matrix axis can target.
 *
 * These are not a taxonomy of "kinds of thing" — they name WHERE in the
 * assembled blueprint a variation lands:
 *
 *   agent   → which agent project is loaded at all
 *   cognet  → the brain bundled into that agent before it boots
 *   model   → config.engine
 *   env     → the agent's environment variables
 *
 * Anything else is reachable by dotted path (see BenchAxisKey), so the named
 * set stays small and ergonomic rather than growing a member per use case.
 * An earlier design had eight kinds — dataset, toolset, judge, value among
 * them — of which only three were ever wired, because the others were not
 * binding points at all: a dataset is the population you measure OVER, and a
 * judge is an assessor, not a property of the subject.
 */
export type BenchAxisName = "agent" | "cognet" | "model" | "env"

/**
 * A matrix axis: a named binding point, or a dotted path into the blueprint
 * for anything without a name (`"config.engine.temperature"`).
 *
 * The template literal keeps `agent` and `model` autocompleting while still
 * admitting arbitrary paths.
 */
export type BenchAxisKey = BenchAxisName | `config.${string}` | `env.${string}`

/** What a variation is allowed to be, per named axis. */
export type BenchAxisValue = {
    /** Path to a local agent project, or a registry ref. */
    agent: string
    /** Path to a local cognet, or a registry ref. */
    cognet: string
    model: EngineRef
    env: Record<string, string>
}

/**
 * One axis of the matrix: the variations to try at a single binding point.
 *
 * One value is a held constant — still pinned into the manifest, because a
 * result is only comparable if the things that did NOT vary are recorded too.
 * Two or more form an axis, and axes multiply.
 */
export type BenchAxis<K extends BenchAxisKey = BenchAxisKey> = {
    key: K
    label?: string
    description?: string
    values: BenchAxisVariation[]
}

export type BenchAxisVariation = {
    /** Stable within the axis; used in cell identities. */
    id: string
    label?: string
    value: unknown
}

/**
 * The authored matrix: every key is an axis, and multiple keys multiply.
 *
 * Deliberately a plain object rather than a list of factor descriptors — the
 * key IS the binding point, so there is nothing to declare twice. A single
 * key is the controlled single-variable experiment, which is the shape to
 * reach for first; more keys is a grid, and the Cartesian growth is the
 * author's to manage rather than the runtime's to hide.
 *
 * A bare value means a held constant: `agent: "@axon/coding-base"` and
 * `agent: ["@axon/coding-base"]` are the same declaration.
 */
export type BenchMatrix = {
    [K in BenchAxisName]?: BenchAxisValue[K] | BenchAxisValue[K][]
} & {
    [path: `config.${string}`]: unknown
} & {
    [path: `env.${string}`]: unknown
}

/** A selected variation on one axis. */
export type BenchAxisSelection = {
    key: BenchAxisKey
    valueId: string
}

/** A raw Cartesian coordinate before values are resolved and pinned. */
export type BenchCoordinate = {
    id: string
    axes: BenchAxisSelection[]
}

/** Manifest-safe identity of a selected value. Secret values are never included. */
export type BenchResolvedAxis = BenchAxisSelection & {
    label: string
    /** Immutable registry version, content hash, or canonical value hash. */
    pin: string
}

/** One fully resolved coordinate, including both varied and constant axes. */
export type BenchCell = {
    id: string
    axes: BenchResolvedAxis[]
}

export type { BenchValue }
