import type { MachineUsage } from "./types"
import type { ProbeT } from "./probe"

type SamplesOpts = {
    probe: ProbeT
    /**
     * Whether anything is currently resident.
     *
     * A thunk because it changes while the daemon runs, and the poll rate
     * follows it — see `interval`. Reached for per tick rather than captured,
     * so a load taken a second ago speeds up the next reading.
     */
    busy: () => boolean
}

/**
 * How much history to keep.
 *
 * At the busy rate this is two minutes — long enough to show a trend, short
 * enough that a spike is still visible rather than averaged away. Fleet's
 * sparklines read exactly this.
 */
const WINDOW = 60

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
        ring.push(opts.probe.read())
        if (ring.length > WINDOW) ring.shift()
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
        const next = opts.busy() ? BUSY_MS : IDLE_MS
        rate = next
        timer = setTimeout(() => {
            record()
            schedule()
        }, next)
        timer.unref?.()
    }

    return {
        /** The poll interval in force, ms. Diagnostics — a surface can say why a graph is coarse. */
        get rate(): number {
            return rate
        },

        /** The newest reading, or null before the first poll completes. */
        latest(): MachineUsage | null {
            return ring[ring.length - 1] ?? null
        },

        /** Every reading held, oldest first. A copy — callers must not mutate the ring. */
        history(): MachineUsage[] {
            return [...ring]
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
