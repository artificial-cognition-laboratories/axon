import type { SpaceHandle } from "../space"
import type { Coord } from "../coord"
import { DEQUANT, type ColumnsHandle } from "./columns"

export type Scored = {
    slot: number
    distance: number
    /** Axes compared on both sides. The sample size behind the estimate. */
    compared: number
    /** `compared` as a fraction of the axes the probe measured in scope. */
    completeness: number
}

/**
 * Bulk ranking: one probe against a whole candidate set, AXIS-MAJOR.
 *
 * ## Why this exists at all
 *
 * `coord/distance.ts` is the reference implementation and is the right shape for
 * comparing two positions. It is the wrong shape for comparing one against fifty
 * thousand, and two attempts proved it:
 *
 *   - materialising a `Coord` per candidate cost ~18x the arithmetic — two
 *     `Float32Array` allocations and a full copy per row, which is row-oriented
 *     work over a columnar store.
 *   - parameterising the metric over an accessor object to avoid that made it
 *     *worse* (272ms vs 184ms): four megamorphic closure calls per axis per
 *     candidate defeat inlining, and cost more than the garbage they removed.
 *
 * So the loop is inverted. Candidates on the inside, axes on the outside: each
 * column is walked once, contiguously, accumulating partial sums for every
 * candidate at once. Nothing is allocated per candidate, nothing is copied, and
 * every read is a direct typed-array index.
 *
 * Columns are quantised to 8 bits, so each read goes through `DEQUANT` —
 * the same table `Columns.coord()` uses, so the two produce bit-identical
 * floats and the equivalence test can assert exact agreement rather than a
 * tolerance.
 *
 * ## The duplication, and what makes it safe
 *
 * This is the metric implemented a second time, which is a real cost. It is bound
 * to the reference by an equivalence test asserting the two agree exactly on
 * random inputs — a proof rather than a convention. Given the alternative cost
 * 50% of throughput, a tested duplicate is the better trade, but it is a trade
 * and the test is the whole of what makes it acceptable.
 */
export function Ranker(opts: { space: SpaceHandle; columns: ColumnsHandle }) {
    const space = opts.space
    const columns = opts.columns

    return {
        rank(
            target: Coord,
            slots: readonly number[],
            opts: { domain?: string; minCompleteness?: number } = {}
        ): Scored[] {
            const n = slots.length
            if (n === 0) return []

            const names = opts.domain ? [space.domains.get(opts.domain).name] : space.domains.names()

            // The probe's own measured axes in scope — the denominator every
            // candidate's completeness is expressed against.
            let available = 0
            for (const name of names) {
                for (const axis of space.domains.axesOf(name)) {
                    if (target.conf[axis]! > 0) available++
                }
            }
            const floor = opts.minCompleteness ?? 0

            // Per candidate, accumulated across domains.
            const total = new Float64Array(n)
            const weights = new Float64Array(n)
            const compared = new Int32Array(n)

            // Reused by every domain, so the allocation is per query rather than per group.
            const sum = new Float64Array(n)
            const dot = new Float64Array(n)
            const magA = new Float64Array(n)
            const magB = new Float64Array(n)
            const count = new Int32Array(n)

            for (const name of names) {
                const domain = space.domains.get(name)
                const cosine = domain.metric === "cosine"

                sum.fill(0)
                count.fill(0)
                if (cosine) {
                    dot.fill(0)
                    magA.fill(0)
                    magB.fill(0)
                }

                for (const axis of space.domains.axesOf(name)) {
                    // Hoisted out of the candidate loop: the probe's own reading for
                    // this axis, and whether it measured it at all.
                    const probeConf = target.conf[axis]!
                    if (probeConf === 0) continue
                    const probeValue = target.values[axis]!
                    const column = columns.column(axis)
                    const values = column.values
                    const conf = column.conf

                    if (cosine) {
                        for (let c = 0; c < n; c++) {
                            const slot = slots[c]!
                            if (conf[slot]! === 0) continue
                            const v = DEQUANT[values[slot]!]!
                            dot[c]! += probeValue * v
                            magA[c]! += probeValue * probeValue
                            magB[c]! += v * v
                            count[c]!++
                        }
                    } else {
                        for (let c = 0; c < n; c++) {
                            const slot = slots[c]!
                            if (conf[slot]! === 0) continue
                            const delta = DEQUANT[values[slot]!]! - probeValue
                            sum[c]! += delta * delta
                            count[c]!++
                        }
                    }
                }

                const weight = domain.weight
                const width = space.domains.axesOf(name).length
                for (let c = 0; c < n; c++) {
                    const seen = count[c]!
                    if (seen === 0) continue

                    let distance: number
                    if (cosine) {
                        const denom = Math.sqrt(magA[c]!) * Math.sqrt(magB[c]!)
                        // No direction to compare — the domain sits out rather than
                        // claiming a perfect match, matching the reference.
                        if (denom === 0) continue
                        distance = 1 - dot[c]! / denom
                    } else {
                        distance = Math.sqrt(sum[c]! / seen)
                    }

                    // Completeness weighting, matching the reference in
                    // `coord/distance.ts`: a domain compared on a fraction of its
                    // axes carries that fraction of its weight.
                    const effective = weight * (seen / width)
                    total[c]! += distance * effective
                    weights[c]! += effective
                    compared[c]! += seen
                }
            }

            const scored: Scored[] = []
            for (let c = 0; c < n; c++) {
                // A candidate sharing no measured axis with the probe was never
                // compared. Dropping it is the honest answer; scoring it would put
                // an uncomparable row into a ranking.
                const seen = compared[c]!
                if (seen === 0) continue
                const completeness = available === 0 ? 0 : seen / available
                // Too thin to compete. A candidate measured on a fraction of what
                // the probe measured is a small-sample estimate, and the minimum
                // over many small samples is won by luck.
                if (completeness < floor) continue
                scored.push({
                    slot: slots[c]!,
                    distance: total[c]! / weights[c]!,
                    compared: seen,
                    completeness: completeness,
                })
            }

            scored.sort((a, b) => a.distance - b.distance)
            return scored
        },
    }
}

export type RankerHandle = ReturnType<typeof Ranker>
