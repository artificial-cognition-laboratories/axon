import type { SpaceHandle } from "../space"
import { centroid, explain, type Coord } from "../coord"
import type { Id } from "../types"
import type { ColumnsHandle } from "./columns"

export type Cluster = {
    members: Id[]
    prototype: Coord
    /** Earliest and latest observation folded in — the span the prototype now stands for. */
    from: number
    to: number
}

export type ConsolidationReport = {
    before: number
    after: number
    clusters: Cluster[]
    /** Groups the pass discovered, including singletons. The cost driver — see `Consolidator`. */
    leaders: number
    /** Distance computations performed. Reported so the cost is visible rather than inferred. */
    comparisons: number
    /** True when `maxLeaders` stopped the pass early, so the caller knows the result is partial. */
    truncated: boolean
}

export type ConsolidationOpts = {
    radius: number
    domain?: string
    /**
     * Only consolidate these rows. Omitted means every live row.
     *
     * The most important knob, because cost is `O(records x leaders)` and the caller
     * is the only thing that can bound either. Consolidating "everything added since
     * last sleep" or "one region's members" is bounded; consolidating a million
     * accumulated records against ten thousand discovered groups is not.
     */
    slots?: readonly number[]
    /**
     * Stop after this many distinct groups.
     *
     * A guard rather than a tuning knob. Leader clustering degrades to a full
     * pairwise scan exactly when nothing clusters — a radius slightly too tight, or
     * genuinely diverse content — and that is the case where the cost explodes
     * silently. Hitting this sets `truncated`, so a partial consolidation announces
     * itself instead of looking like a complete one that found little.
     */
    maxLeaders?: number
}

/**
 * Memory consolidation: cluster nearby positions, replace them with their centroid.
 *
 * This is the operation a knowledge graph cannot offer, and the reason is
 * structural rather than incidental. Here, consolidation is ARITHMETIC with one
 * knob — and it is monotone, so it can always be run harder. In a graph,
 * "merge these into an abstraction" requires deciding which edges survive, which
 * is a judgement, which means a model.
 *
 * It also degrades in the right direction: precision is lost, POSITION is kept.
 * An old memory collapses toward its centroid, so the episode fades while
 * "something like this happened, in this region" survives. Episodic detail
 * fading into gist is what human semantic memory does, and here it falls out of
 * the mean rather than being designed in.
 *
 * ## Why leader clustering, and what it costs
 *
 * The first implementation was pairwise: for each unclaimed row, scan every other
 * unclaimed row. That is fine when a few large clusters absorb everything and
 * quadratic when they do not — and "many small clusters" is precisely what an
 * accumulating memory looks like. Since consolidation is the headline argument for
 * this whole approach, that was the largest gap between what the design claims and
 * what the code could do.
 *
 * This is a single pass comparing each row only against the LEADERS found so far:
 * `O(records x leaders)` rather than `O(records²)`. Leaders are few when content
 * clusters, which is the case consolidation is for.
 *
 * It does not make the cost disappear, it makes it **bounded and visible**. The
 * honest conclusion from the arithmetic is the same as for ranking: *never
 * consolidate the whole store.* Scope it — a window of recent records, one
 * region's members — and the cost is the caller's to choose. `comparisons` is
 * reported so that choice can be made from a number.
 *
 * One property worth knowing: leader clustering is **order-dependent**. Which row
 * becomes a leader depends on the order rows are visited, so two runs over the same
 * data in different orders can produce different groupings. Slots are visited in
 * ascending order, which is insertion order, so a given store consolidates
 * reproducibly.
 */
export function Consolidator(opts: { space: SpaceHandle; columns: ColumnsHandle }) {
    const space = opts.space
    const columns = opts.columns

    return {
        /**
         * Compute clusters without touching anything.
         *
         * Separate from applying them because the compression-versus-retention
         * curve is the number worth knowing, and measuring it means proposing a
         * consolidation and querying against the result — not destroying the
         * original first.
         */
        plan(opts: ConsolidationOpts): ConsolidationReport {
            const scoped = opts.domain === undefined ? {} : { domain: opts.domain }
            const slots = opts.slots ?? [...columns.slotsLive()]
            const maxLeaders = opts.maxLeaders ?? Number.POSITIVE_INFINITY

            // A leader is a group's first member: its coordinate is what later rows
            // are tested against, and its membership accumulates.
            const leaders: { coord: Coord; slots: number[]; from: number; to: number }[] = []
            let comparisons = 0
            let truncated = false

            for (const slot of slots) {
                const coord = columns.coord(slot)
                const at = columns.at[slot]!
                let home: (typeof leaders)[number] | null = null

                for (const leader of leaders) {
                    comparisons++
                    const detail = explain(space, leader.coord, coord, scoped)
                    // Uncomparable rows are not "far" — they were never compared, so
                    // they cannot join a group on the strength of a missing answer.
                    if (detail.compared === 0) continue
                    if (detail.distance > opts.radius) continue
                    home = leader
                    break
                }

                if (home) {
                    home.slots.push(slot)
                    if (at < home.from) home.from = at
                    if (at > home.to) home.to = at
                    continue
                }

                if (leaders.length >= maxLeaders) {
                    truncated = true
                    break
                }
                leaders.push({ coord: coord, slots: [slot], from: at, to: at })
            }

            const clusters: Cluster[] = []
            for (const leader of leaders) {
                // A group of one is not a consolidation. Leaving it alone keeps the
                // operation monotone: running again with the same radius is a no-op.
                if (leader.slots.length < 2) continue
                const members = leader.slots.map(slot => columns.idAt(slot)).filter((id): id is Id => id !== null)
                clusters.push({
                    members: members,
                    prototype: centroid(space, leader.slots.map(slot => columns.coord(slot))),
                    from: leader.from,
                    to: leader.to,
                })
            }

            const merged = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0)
            return {
                before: slots.length,
                after: slots.length - merged + clusters.length,
                clusters: clusters,
                leaders: leaders.length,
                comparisons: comparisons,
                truncated: truncated,
            }
        },
    }
}

export type ConsolidatorHandle = ReturnType<typeof Consolidator>
