import type { Coord } from "./coord"

export type Id = string

/**
 * One stored thing.
 *
 * Composed rather than schema'd — the same idea as an ECS entity, and for the
 * same reason: adding a new KIND of knowledge should be a new component, not a
 * migration. `coord` is the only component the metric reads; everything else is
 * a filter or a payload.
 */
export type LocusRecord = {
    id: Id
    coord: Coord
    /** When this was observed. A filter and a sort key — never an axis, because a timestamp in a coordinate would dominate every distance. */
    at: number
    /** Arbitrary content, stored beside the position rather than inside it. A coordinate is an index, not a compression. */
    payload?: unknown
}

/** What `put` accepts — `id` and `at` are filled in when omitted. */
export type RecordInput = {
    id?: Id
    coord: Coord
    at?: number
    payload?: unknown
}

export type Predicate =
    | { gt: number }
    | { gte: number }
    | { lt: number }
    | { lte: number }
    | { eq: number }
    | { between: [number, number] }
    /** Was this axis measured at all? The question a value-based predicate cannot ask. */
    | { measured: boolean }

export type Query = {
    where?: Readonly<Record<string, Predicate>>
    when?: { from?: number; to?: number }
    limit?: number
}

export type NearQuery = Query & {
    /** Rank within one domain only. */
    domain?: string
    /**
     * Refuse to rank a candidate measured on less than this fraction of the axes
     * the probe measured in scope. `0` (the default) ranks everything comparable.
     *
     * **Polls of different sizes must not compete.** A distance is an estimate
     * from however many axes two records share, and `near()` takes the minimum
     * over every candidate — so a thinly measured row can win by luck rather than
     * by being near. Lab e4 measured `recall@1` falling 0.855 to 0.165 as coverage
     * thinned, with the same-vs-other margin nearly unmoved: the signal was intact
     * and the estimates were too noisy to read it.
     *
     * Set this when a store holds records assessed by different producers. It is a
     * FILTER, not a change to the metric — the honest answer for a thin candidate
     * is "I cannot confirm this is near", which is the same reasoning that makes
     * an absent measurement refuse to compare rather than compare as zero.
     */
    minCompleteness?: number
}

/** One narrowing step, with what it cost. */
export type Clause = {
    kind: "live" | "axis" | "time" | "coverage"
    detail: string
    /** Rows surviving before this clause. */
    before: number
    /** Rows surviving after it. */
    after: number
}

/**
 * How a query was answered.
 *
 * Not a debug flag and not optional. A memory system that cannot say how it
 * reached an answer is an untraceable path through the most important part of a
 * mind — and per-clause selectivity is also exactly what a debugger needs to
 * show why a query returned nothing.
 */
export type Plan = {
    clauses: Clause[]
    /** Rows considered by the ranking step. */
    ranked: number
    /** Which metric ranked them, if any. */
    metric?: string
    /** Which domain the metric was scoped to, if any. */
    domain?: string
    /**
     * How complete the ranked candidates were, as a fraction of the probe's own
     * measured axes in scope.
     *
     * Reported on every ranking because a wide spread here is the signature of the
     * one failure mode that produces plausible wrong answers: candidates compared
     * on very different numbers of axes, where the thin ones win by noise. A `min`
     * far below `max` means this ranking should not be trusted, and nothing else
     * in the result would have said so.
     */
    coverage?: { min: number; max: number; mean: number }
}

export type Hit = {
    record: LocusRecord
    /** Present only for `near` — box queries do not rank. */
    distance?: number
    /** How many axes this distance was computed from. A small number is a weak claim. */
    compared?: number
}

export type Result = {
    hits: Hit[]
    plan: Plan
}
