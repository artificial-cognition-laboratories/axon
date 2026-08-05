import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

type ContinuousOpts = {
    session: AxonSessionT
    reserve: (opts?: { exclusive?: boolean }) => string
    release: (id?: string) => void
    runWake: (reservationId: string, input: { stimuli: AxonStimulusEntry[] }) => AsyncGenerator<AxonEntry>
}

/**
 * Continuous trigger: the brain woken on its own rhythm.
 *
 * THE BRAIN OWNS THE CLOCK. This has moved twice, and both moves were the
 * same correction. First it was `start(tickMs)` reading a rate the cognet
 * declared in its config — the brain asserting how fast the world turns,
 * which it cannot know. Then it was `axon.tick()` in the body — the body
 * asserting how often a mind should think, which it cannot know either, and
 * which broke the swap test: a body that drives a specific brain has to be
 * rewritten when the brain changes. It also had no answer under composition,
 * where two sensors at 31Hz and 60Hz have equal claim to being "the" rate.
 *
 * The resolution is that these are different quantities. How fast frames
 * arrive is the body's. How often it is worth thinking about them is the
 * mind's. So a cognet plugin drives `kernel.wake()`, and the body only ever
 * emits stimuli.
 *
 * OVERLAP POLICY: wakes overlap. Every wake starts, always, however long the
 * last one is still taking.
 *
 * This began as skip-on-overlap, which suited a controller whose sensor
 * could be re-read at any moment: a late tick was worthless, so dropping it
 * cost nothing. That reasoning does not survive transient stimuli. A
 * stimulus is delivered once and then dropped, so a skipped tick is not a
 * late tick — it is a tick that never heard, and the frames it would have
 * carried are gone. A mind that stops hearing while it thinks cannot be
 * interrupted, which rules out every conversational workload.
 *
 * Queueing is worse still: two seconds of backlog arrives at one tick, that
 * tick runs long, and the backlog compounds.
 *
 * So wakes run concurrently and share the cognet's module scope, exactly as
 * a brain's regions share one body. Coordinating that — not calling the
 * engine twice, dropping work that arrived while busy — is the cognet
 * author's, through their own state. The kernel supplies no primitive for
 * it, because any primitive would be the runtime having an opinion about
 * how cognition should be organised.
 *
 * The log stays coherent under this: one writer, and `seq` is still a total
 * order. What changes is that spans from different wakes interleave, so
 * nesting is rebuilt per `context.runId` rather than globally.
 */
export function Continuous(opts: ContinuousOpts) {
    let wakes = 0

    return {
        /** Wakes admitted since boot — what kernel.clock() reports. */
        get wakes() {
            return wakes
        },

        /**
         * Wake the cognet with whatever is on the stimulus buffer.
         *
         * Resolves with this wake's ordinal AS SOON AS IT IS ADMITTED, not
         * when it finishes. That distinction is the whole point: a driver
         * doing `setInterval(async () => await kernel.wake(), 33)` would
         * otherwise wait for each wake before starting the next, which is
         * skip-on-overlap reintroduced by the back door — the exact behaviour
         * that makes a mind deaf while it thinks.
         *
         * The wake itself runs detached. Its entries reach the log, which is
         * where a ticked cognet's output belongs; there is no caller waiting
         * on a wire, because a clock is not asking a question.
         */
        async wake(): Promise<number> {
            // Never exclusive: a wake that waited for the previous one would
            // be a wake that did not hear. Stimuli are transient — delivered
            // once, then dropped — so a skipped or delayed tick does not
            // arrive late, it never arrives at all. Overlapping wakes are the
            // point, not the hazard.
            const reservationId = opts.reserve({ exclusive: false })
            const ordinal = ++wakes

            const stimuli = opts.session.stimuli.drain()

            // Drained here rather than yielded: runWake's finally releases the
            // reservation, so the generator MUST be consumed to completion or
            // the reservation leaks. Deliberately NOT awaited — see above.
            // The catch is what keeps a failed wake from surfacing as an
            // unhandled rejection in whatever interval called tick(); the
            // failure is already durable (kernel:run:failed) by the time it
            // reaches here.
            void (async () => {
                for await (const _entry of opts.runWake(reservationId, { stimuli })) {
                    // entries commit as they are produced; nothing to collect
                }
            })().catch(() => {})

            return ordinal
        },
    }
}

export type ContinuousT = ReturnType<typeof Continuous>
