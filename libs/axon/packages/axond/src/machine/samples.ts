import type { MachineUsage } from "./types"
import type { ProbeT } from "./probe"
import type { ShareT } from "./share"

type SamplesOpts = {
    probe: ProbeT
    /**
     * Bytes Axon holds, read at the moment of each reading.
     *
     * Stamped on here rather than inside `Probe`, which reads the machine and
     * must stay ignorant of residency. Taking both at one instant is what
     * makes the two series in `MachineUsage` structurally aligned — a chart
     * drawing our share inside the machine's total cannot drift, because there
     * is no second array to drift from.
     */
    held: () => number
    /**
     * Axon's own consumption, read at the moment of each reading.
     *
     * Same argument as `held`: the probe reads the machine and must stay
     * ignorant of who is using it, so the share is stamped on here. Taking
     * both at one instant is what keeps the two series in a chart structurally
     * aligned rather than aligned by convention.
     */
    share: ShareT
    /**
     * Whether anything is currently resident.
     *
     * A thunk because it changes while the daemon runs, and the poll rate
     * follows it — see `interval`. Reached for per tick rather than captured,
     * so a load taken a second ago speeds up the next reading.
     */
    busy: () => boolean
    /**
     * Whether anything is DRAWING these readings right now.
     *
     * A third tier above busy, because the two answer different questions: busy
     * means an admission decision could be pending, watched means a person is
     * looking at a line move. A graph stepping twice a second reads as live; at
     * one step every two seconds it reads as a slideshow.
     */
    watched?: () => boolean
}

/**
 * How much history to keep.
 *
 * How much TIME the ring holds, not how many readings.
 *
 * The cadence varies twenty-fold between watched and idle, so a count meant
 * the window was five minutes of history at one rate and thirty seconds at
 * another — and a chart drawn on a fixed axis was full or a fifth full
 * depending on whether anyone had been looking. Bounding by age makes the
 * span the same fact regardless of how often it was sampled.
 */
const SPAN_MS = 5 * 60_000

/**
 * A ceiling on readings held, whatever the span implies.
 *
 * At the watched rate five minutes is six hundred readings; this caps the
 * memory and, more importantly, the size of what crosses a pipe every tick.
 */
const CAP = 600

/**
 * Poll rates.
 *
 * ADAPTIVE, because the cost is real but only when it buys something. A probe
 * is ~25ms of subprocess; at 2s that is barely over one percent of a core and
 * gives a usable trend while models are loaded. With nothing resident there is
 * no admission decision pending and nobody watching a graph, so ten seconds is
 * plenty — and the difference is the daemon idling at ~0.25% instead.
 */
const BUSY_MS = 2_000
const IDLE_MS = 10_000

/**
 * The rate while a surface is drawing.
 *
 * Bounded by the GPU probe, which is a subprocess costing ~18ms — at 500ms
 * that is under four percent of a core, and it only runs while something is on
 * screen. Faster is possible for CPU and memory, which are single `/proc`
 * reads, but a chart whose four lines advanced at different rates would be
 * lying about when each reading was taken.
 */
const WATCHED_MS = 500

/**
 * Samples — recent usage readings, on a timer.
 *
 * The reason the daemon exists for this domain: only a long-lived process can
 * afford to poll, and only a poll can answer "is VRAM climbing" — which is
 * what decides whether a load that fits now will still fit in a minute.
 *
 * Nothing here throws. `Probe` reports unreadable fields as null, so a machine
 * with no GPU produces samples with null video memory rather than an empty
 * ring, and a consumer sees "unknown" instead of a gap it has to interpret.
 */
export function Samples(opts: SamplesOpts) {
    const ring: MachineUsage[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let rate = IDLE_MS

    function record(): void {
        ring.push({ ...opts.probe.read(), held: opts.held(), axon: opts.share.read() })

        const oldest = Date.now() - SPAN_MS
        while (ring.length > 0 && ring[0]!.at < oldest) ring.shift()
        while (ring.length > CAP) ring.shift()
    }

    /**
     * Schedule the next read at the current rate.
     *
     * A self-rescheduling timeout rather than an interval: the rate changes
     * with residency, and an interval would have to be torn down and rebuilt
     * to follow it. Unref'd so a poll never keeps the process alive on its own
     * — the daemon exits when its socket closes, not when a timer says so.
     */
    function schedule(): void {
        const next = opts.watched?.() ? WATCHED_MS : opts.busy() ? BUSY_MS : IDLE_MS
        rate = next
        timer = setTimeout(() => {
            record()
            schedule()
        }, next)
        timer.unref?.()
    }

    return {
        /**
         * Re-evaluate the rate NOW, rather than at the next tick.
         *
         * `schedule` picks the interval once, when it arms the timer — so a
         * daemon that armed a ten-second idle tick and then had a panel open
         * on it stays frozen for the rest of that ten seconds. The graph opens
         * on a line that does not move, which reads as a broken stream rather
         * than a slow one.
         *
         * Only ever speeds up. Rearming for a SLOWER rate would push the next
         * reading further away every time the last watcher left, and a
         * flapping watcher could starve the ring indefinitely.
         */
        kick(): void {
            if (!timer) return
            const next = opts.watched?.() ? WATCHED_MS : opts.busy() ? BUSY_MS : IDLE_MS
            if (next >= rate) return
            clearTimeout(timer)
            timer = undefined
            schedule()
        },

        /** The poll interval in force, ms. Diagnostics — a surface can say why a graph is coarse. */
        get rate(): number {
            return rate
        },

        /** The newest reading, or null before the first poll completes. */
        latest(): MachineUsage | null {
            return ring[ring.length - 1] ?? null
        },

        /**
         * Every reading held, oldest first. A copy — callers must not mutate the ring.
         *
         * `max` thins rather than truncating, so a caller with a budget gets
         * the whole span at lower resolution instead of a recent slice of it.
         * A chart drawn from a truncated history would silently claim the
         * machine started when the budget did.
         *
         * ── Why buckets, and why anchored to the epoch ──────────────────────
         *
         * Thinning by INDEX — every nth reading — picks a different subset
         * every time the ring grows by one, because the stride is a function
         * of the ring's length. Each tick therefore sent a chart built from
         * different readings than the last, and the line visibly rewrote its
         * own history sixty times a minute while the underlying data had not
         * changed at all.
         *
         * Bucketing by WALL-CLOCK time fixes the stride. `SPAN_MS` is a
         * constant and so is `max`, so the bucket width is constant, and
         * flooring an absolute timestamp by it gives a reading the same slot
         * for as long as it is held. Only the newest bucket moves; every
         * older point is pinned. That is what makes the line scroll instead
         * of shimmer.
         *
         * The LAST reading in a bucket wins — the freshest thing known about
         * that slice of time, and the one an averaging scheme would smear.
         */
        history(max?: number): MachineUsage[] {
            if (!max || ring.length <= max) return [...ring]

            const bucketMs = Math.max(1, Math.ceil(SPAN_MS / max))
            const out: MachineUsage[] = []
            let current = Number.NaN

            for (const reading of ring) {
                const bucket = Math.floor(reading.at / bucketMs)
                if (bucket === current) out[out.length - 1] = reading
                else {
                    out.push(reading)
                    current = bucket
                }
            }
            return out
        },

        /**
         * Take a reading NOW, outside the poll.
         *
         * For the caller that cannot wait for the next tick: an admission
         * check has to decide against what is true at this instant, and a
         * two-second-old reading is two seconds in which another process took
         * the memory.
         */
        now(): MachineUsage {
            record()
            return ring[ring.length - 1]!
        },

        /** Begin polling. Idempotent — a second call does not stack timers. */
        start(): void {
            if (timer) return
            record()
            schedule()
        },

        stop(): void {
            if (!timer) return
            clearTimeout(timer)
            timer = undefined
        },
    }
}

export type SamplesT = ReturnType<typeof Samples>
