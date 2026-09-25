/**
 * Ticks — the cognet's monotonic world clock counter.
 *
 * Lives for the cognet's lifetime, NOT the wake's. Clock() is constructed per
 * wake (it carries that wake's abort signal), so a counter owned by Clock
 * restarts at zero every time — which is invisible for an invocation cognet,
 * where one wake is one conversation and many ticks, and completely wrong for
 * a continuous one, where every wake is a single tick. A 20Hz control loop
 * stamped every event `tick: 1` forever, so the flame graph could not order
 * two ticks and nothing keyed on tick could replay.
 *
 * The counter is therefore owned by the host and handed to each wake's Clock.
 * It is also what lets the world stamp a mutation that happens outside any
 * wake — boot-time entity spawning has a real tick, just no phase.
 */
export function Ticks() {
    let tick = 0

    return {
        /** The tick in progress. Zero before the first one begins. */
        current(): number {
            return tick
        },

        /** Opens the next tick and returns it. Only Clock.runTick calls this. */
        next(): number {
            tick += 1
            return tick
        },
    }
}

export type TicksT = ReturnType<typeof Ticks>
