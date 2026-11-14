import type { Tally } from "./types"

/** The upper edge of each bucket a duration is counted in, ms. */
export const BOUNDS = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500, 800, 1200, 2000, 5000, Infinity]

/** Durations, counted — plain functions. */
export const tally = {
    start(): Tally {
        return { count: 0, totalMs: 0, maxMs: 0, hist: new Array<number>(BOUNDS.length).fill(0) }
    },

    add(into: Tally, ms: number): void {
        into.count++
        into.totalMs += ms
        if (ms > into.maxMs) into.maxMs = ms
        into.hist[BOUNDS.findIndex(bound => ms <= bound)]!++
    },

    merge(into: Tally, from: Tally): void {
        into.count += from.count
        into.totalMs += from.totalMs
        if (from.maxMs > into.maxMs) into.maxMs = from.maxMs
        from.hist.forEach((count, bucket) => { into.hist[bucket]! += count })
    },

    /**
     * The duration `share` of runs came in under — to the edge of the bucket
     * it falls in, so an upper bound and not the exact figure. The slowest
     * bucket has no edge; the worst run stands in for it.
     */
    within(of: Tally, share: number): number {
        if (of.count === 0) return 0
        let seen = 0
        for (let bucket = 0; bucket < BOUNDS.length; bucket++) {
            seen += of.hist[bucket]!
            if (seen >= of.count * share) return Math.min(BOUNDS[bucket]!, of.maxMs)
        }
        return of.maxMs
    },

    mean(of: Tally): number {
        return of.count === 0 ? 0 : Math.round(of.totalMs / of.count * 100) / 100
    },
}
