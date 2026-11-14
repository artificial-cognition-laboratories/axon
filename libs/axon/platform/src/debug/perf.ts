import { tally } from "./tally"
import type { Summary, SystemTally, Tally } from "./types"

/** A duration summed, as a command reports it. `p95Ms` is to the edge of a bucket — an upper bound. */
type Timing = { runs: number; meanMs: number; p95Ms: number; maxMs: number; totalMs: number }

/**
 * Perf — how long the mind took, from the index.
 *
 * Over the telemetry still on disk, which is a window: the last stretch of
 * the session, not all of it. A system that ran beside the tick is marked
 * `async`; its time is wall time waiting, not time the tick was held up.
 * What a tick WAS held up by is `heldMs`: the time ticks spent waiting on a
 * system — a worker the rest of the tick needed, or a lagged run landing late.
 */
export function Perf() {
    return {
        /** The window, the ticks, and every system, costliest first. `only` narrows to systems whose name ends with it. */
        of(summary: Summary, only?: string) {
            const segments = Object.values(summary.segments)
            const ticks = tally.start()
            const main = tally.start()
            const systems: Record<string, SystemTally> = {}
            const held: Record<string, Tally> = {}
            let over = 0
            let late = 0
            for (const segment of segments) {
                tally.merge(ticks, segment.ticks)
                tally.merge(main, segment.main)
                over += segment.over
                late += segment.late
                for (const [name, from] of Object.entries(segment.held)) tally.merge(held[name] ??= tally.start(), from)
                for (const [name, from] of Object.entries(segment.systems)) {
                    const into = systems[name] ??= { ...tally.start(), failed: 0, async: false, threads: [] }
                    tally.merge(into, from)
                    into.failed += from.failed
                    into.async ||= from.async
                    for (const thread of from.threads) if (!into.threads.includes(thread)) into.threads.push(thread)
                }
            }
            const fromMs = segments.length ? Math.min(...segments.map(segment => segment.firstMs)) : null
            const toMs = segments.length ? Math.max(...segments.map(segment => segment.lastMs)) : null
            const seconds = fromMs !== null && toMs !== null ? (toMs - fromMs) / 1000 : 0
            const hz = summary.log.declared?.hz ?? null
            return {
                window: { fromMs: fromMs, toMs: toMs, seconds: Math.round(seconds * 10) / 10, segments: segments.length },
                ticks: {
                    perSecond: seconds > 0 ? Math.round(ticks.count / seconds * 10) / 10 : 0,
                    targetPerSecond: hz,
                    targetMs: hz ? Math.round(1000 / hz * 10) / 10 : null,
                    // Each tick, start to end: what a tick past the deadline ran over in.
                    wall: timing(ticks),
                    late: late,
                    // The main thread's share of it.
                    main: timing(main),
                    overTarget: over,
                },
                systems: Object.entries(systems)
                    .filter(([name]) => only === undefined || name === only || name.endsWith(`/${only}`))
                    .sort((a, b) => b[1].totalMs - a[1].totalMs)
                    .map(([name, of]) => ({ system: name, ...timing(of), heldMs: Math.round(held[name]?.totalMs ?? 0), heldTicks: held[name]?.count ?? 0, failed: of.failed, async: of.async, threads: [...of.threads].sort((a, b) => a - b) })),
                /** The systems ticks waited on, longest wait first. */
                held: Object.entries(held)
                    .sort((a, b) => b[1].totalMs - a[1].totalMs)
                    .map(([name, of]) => ({ system: name, ticks: of.count, totalMs: Math.round(of.totalMs), meanMs: tally.mean(of), maxMs: Math.round(of.maxMs) })),
            }
        },
    }
}

export type PerfT = ReturnType<typeof Perf>

function timing(of: Tally): Timing {
    return { runs: of.count, meanMs: tally.mean(of), p95Ms: tally.within(of, 0.95), maxMs: Math.round(of.maxMs * 100) / 100, totalMs: Math.round(of.totalMs) }
}
