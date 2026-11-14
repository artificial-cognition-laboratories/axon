import type { SpaceHandle } from "../space"
import type { Coord } from "../coord"
import type { Clause, NearQuery, Plan, Predicate, Query } from "../types"
import type { ColumnsHandle } from "./columns"
import { LEVELS } from "./columns"
import { Ranker } from "./rank"

/**
 * The query planner: filters narrow, one metric ranks.
 *
 * That split is the organising principle of the whole package. Time, axis
 * predicates and (later) text or edges are all FILTERS — exact, cheap, and
 * extensible one component type at a time. Distance in the space is the single
 * METRIC, and it is the only expensive step, so it runs last over whatever
 * survived. It is how boolean retrieval then scoring has worked for decades, and
 * it is why a growing feature list here is not a growing pile of comparison
 * methods.
 *
 * Every call reports its clauses and their selectivity. Not optional: the most
 * common failure in a memory system is a query that silently matched nothing,
 * and the only way to see why is to see which clause ate the rows.
 */
export function Planner(opts: { space: SpaceHandle; columns: ColumnsHandle }) {
    const space = opts.space
    const columns = opts.columns
    const ranker = Ranker({ space: space, columns: columns })

    return {
        /** Narrow only. Insertion order, no ranking — box queries have no notion of "best". */
        select(query: Query): { slots: number[]; plan: Plan } {
            const narrowed = narrow(query)
            const limit = query.limit ?? narrowed.slots.length
            return {
                slots: narrowed.slots.slice(0, limit),
                plan: { clauses: narrowed.clauses, ranked: 0 },
            }
        },

        /** Narrow, then rank the survivors by distance. Ranking is delegated to the bulk, axis-major `Ranker`. */
        rank(
            target: Coord,
            query: NearQuery
        ): { slots: number[]; distances: number[]; compared: number[]; plan: Plan } {
            const narrowed = narrow(query)
            const clauses = [...narrowed.clauses]

            const comparable = ranker.rank(target, narrowed.slots, {
                ...(query.domain !== undefined ? { domain: query.domain } : {}),
            })

            // The coverage floor is a FILTER, so it reports as one — a ranking that
            // silently dropped half its candidates should say which clause did it.
            const floor = query.minCompleteness ?? 0
            const scored = floor > 0 ? comparable.filter(hit => hit.completeness >= floor) : comparable
            if (floor > 0) {
                clauses.push({
                    kind: "coverage",
                    detail: `completeness >= ${floor}`,
                    before: comparable.length,
                    after: scored.length,
                })
            }

            const limited = scored.slice(0, query.limit ?? scored.length)

            return {
                slots: limited.map(hit => hit.slot),
                distances: limited.map(hit => hit.distance),
                compared: limited.map(hit => hit.compared),
                plan: {
                    clauses: clauses,
                    ranked: scored.length,
                    metric: "distance",
                    ...(query.domain !== undefined ? { domain: query.domain } : {}),
                    ...(scored.length > 0 ? { coverage: spread(scored) } : {}),
                },
            }
        },
    }

    /** Apply every filter in cost order — cheapest and most selective first. */
    function narrow(query: Query): { slots: number[]; clauses: Clause[] } {
        const clauses: Clause[] = []

        let slots: number[] = [...columns.slotsLive()]
        clauses.push({ kind: "live", detail: "live rows", before: columns.extent, after: slots.length })

        if (query.when) {
            const before = slots.length
            const from = query.when.from ?? Number.NEGATIVE_INFINITY
            const to = query.when.to ?? Number.POSITIVE_INFINITY
            const at = columns.at
            slots = slots.filter(slot => at[slot]! >= from && at[slot]! <= to)
            clauses.push({ kind: "time", detail: rangeLabel(query.when), before: before, after: slots.length })
        }

        for (const [name, predicate] of Object.entries(query.where ?? {})) {
            const before = slots.length
            const index = space.axes.index(name)
            const column = columns.column(index)
            slots = slots.filter(slot => holds(predicate, column.values[slot]!, column.conf[slot]!))
            clauses.push({ kind: "axis", detail: `${name} ${predicateLabel(predicate)}`, before: before, after: slots.length })
        }

        return { slots: slots, clauses: clauses }
    }
}

export type PlannerHandle = ReturnType<typeof Planner>

/**
 * Does a predicate hold?
 *
 * An unmeasured axis fails every value predicate rather than comparing as 0.
 * `danger > 0.5` must not be satisfied by a row nobody ever assessed for danger,
 * and `danger < 0.5` must not be either — the honest answer to both is "this row
 * cannot say". `{ measured }` is the predicate that asks the question directly.
 *
 * Comparisons happen in QUANTISED space. Columns hold levels 0-255, so a
 * caller's `0.8` is scaled to `204` and compared against the stored level
 * directly — exact integer-against-float, with no rounding of the stored side and
 * no epsilon. This replaces an earlier `Math.fround` fix for the same class of
 * bug: a threshold expressed in one precision and data stored in another made
 * `lte: 0.8` exclude a row holding exactly 0.8.
 *
 * `eq` is the one predicate quantisation makes fuzzy — it matches a level, not a
 * float — so it holds for any value that rounds to the same level.
 */
function holds(predicate: Predicate, level: number, confidence: number): boolean {
    if ("measured" in predicate) return (confidence > 0) === predicate.measured
    if (confidence === 0) return false
    if ("gt" in predicate) return level > predicate.gt * LEVELS
    if ("gte" in predicate) return level >= predicate.gte * LEVELS
    if ("lt" in predicate) return level < predicate.lt * LEVELS
    if ("lte" in predicate) return level <= predicate.lte * LEVELS
    if ("eq" in predicate) return level === Math.round(predicate.eq * LEVELS)
    return level >= predicate.between[0] * LEVELS && level <= predicate.between[1] * LEVELS
}

/** Completeness spread over a ranked set. A wide gap between min and max is the untrustworthy case. */
function spread(scored: readonly { completeness: number }[]): { min: number; max: number; mean: number } {
    let min = Number.POSITIVE_INFINITY
    let max = 0
    let sum = 0
    for (const hit of scored) {
        if (hit.completeness < min) min = hit.completeness
        if (hit.completeness > max) max = hit.completeness
        sum += hit.completeness
    }
    return { min: min, max: max, mean: sum / scored.length }
}

function predicateLabel(predicate: Predicate): string {
    if ("measured" in predicate) return predicate.measured ? "is measured" : "is unmeasured"
    if ("gt" in predicate) return `> ${predicate.gt}`
    if ("gte" in predicate) return `>= ${predicate.gte}`
    if ("lt" in predicate) return `< ${predicate.lt}`
    if ("lte" in predicate) return `<= ${predicate.lte}`
    if ("eq" in predicate) return `= ${predicate.eq}`
    return `in [${predicate.between[0]}, ${predicate.between[1]}]`
}

function rangeLabel(when: { from?: number; to?: number }): string {
    if (when.from !== undefined && when.to !== undefined) return `at in [${when.from}, ${when.to}]`
    if (when.from !== undefined) return `at >= ${when.from}`
    return `at <= ${when.to}`
}
