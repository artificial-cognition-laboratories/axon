import { err } from "@arcforge/err"
import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

type ContinuousOpts = {
    session: AxonSessionT
    reserve: () => string
    release: (id?: string) => void
    runWake: (reservationId: string, input: { stimuli: AxonStimulusEntry[] }) => AsyncGenerator<AxonEntry>
}

/**
 * Continuous trigger: invoked on a fixed clock regardless of whether
 * anything arrived — an empty stimuli diff is the ordinary steady state,
 * not an edge case a cognet needs to special-case.
 *
 * STUBBED. Landing the shape (type, wiring, start/stop lifecycle) now
 * without guessing at tick semantics — no real continuous cognet exists
 * yet to validate wake-overlap policy against (does a slow tick skip the
 * next one, queue, or run concurrently?). Answering this without a real
 * workload would be exactly the kind of premature generalization this
 * whole redesign was trying to avoid. (The removal of "thread" as a
 * concept actually simplifies what's left to design here — there's no
 * longer a question of which of several conversations a tick addresses;
 * one cognet instance is always exactly one continuous stream.)
 */
export function Continuous(_opts: ContinuousOpts) {
    let timer: ReturnType<typeof setInterval> | null = null

    return {
        start(_tickMs: number) {
            throw err("SCHEDULER_CONTINUOUS_NOT_IMPLEMENTED", {
                detail: "continuous mode is a declared, stubbed shape — no cognet may select it yet",
            })
        },

        stop() {
            if (timer) clearInterval(timer)
            timer = null
        },
    }
}

export type ContinuousT = ReturnType<typeof Continuous>
