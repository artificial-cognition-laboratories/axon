import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

type InvocationOpts = {
    session: AxonSessionT
    reserve: () => string
    release: (id?: string) => void
    runWake: (reservationId: string, input: { stimuli: AxonStimulusEntry[] }) => AsyncGenerator<AxonEntry>
    interrupt: (reason: "user" | "shutdown", reservationId?: string) => void
}

/**
 * How long a reserved-but-never-consumed wire holds the scheduler before the
 * lock is dropped. Generous on purpose: a legitimate consumer starts pulling
 * within microseconds, so anything at this scale is genuinely abandoned, and
 * releasing early on a slow-but-real caller would be worse than the wedge
 * this guards against.
 */
const ABANDON_MS = 30_000

type StreamInput = {
    content?: string | string[]
}

/**
 * Invocation trigger: one wake per admitted stimulus. The caller (kernel's
 * public stream()/request()) supplies the thing that just happened —
 * usually a user message — which gets committed as the FIRST stimulus, then
 * the scheduler drains whatever else has accumulated on the buffer since the
 * last invoke (stimuli.ts's own design: several may have queued while the
 * previous wake was still running) and hands the cognet the whole diff in
 * one call.
 */
export function Invocation(opts: InvocationOpts) {
    function stream(input: StreamInput = {}) {
        const reservationId = opts.reserve()

        // reserve() is synchronous — it has to be, or two callers could both
        // mint a wire before either locked (see Scheduler.reserve). But an
        // async generator's body does not run until it is iterated, so
        // between this call and the first pull the scheduler is LOCKED with
        // nothing running and no release path: runWake's finally lives
        // inside the generator.
        //
        // A caller that never consumes the wire therefore wedges the runtime
        // permanently — every later request throws RUN_IN_PROGRESS until the
        // process restarts. That is not hypothetical: /_axon/stream hands the
        // wire to a ReadableStream whose start() only fires when the client
        // reads, so a client disconnecting in that window would take the
        // agent down remotely.
        //
        // The timer closes the window. It is cancelled the instant the body
        // actually starts, so a consumed wire never sees it; only an
        // abandoned one does.
        const abandoned = setTimeout(() => opts.release(reservationId), ABANDON_MS)

        const wire = (async function* () {
            clearTimeout(abandoned)
            try {
                const contents = input.content === undefined
                    ? []
                    : Array.isArray(input.content) ? input.content : [input.content]
                for (const content of contents) {
                    const entry = await opts.session.stimuli.ingest("cognet:stimulus:text", {
                        source: { channel: "user" },
                        content,
                    })
                    yield entry
                }

                const stimuli = opts.session.stimuli.drain()
                yield* opts.runWake(reservationId, { stimuli })
            } catch (cause) {
                opts.release(reservationId)
                throw cause
            }
        })()

        return {
            stream: wire,
            interrupt: () => {
                // Abort first — it matches on the reservation id, so
                // releasing ahead of it would make the abort a no-op against
                // a wake that IS running. Then drop the reservation, which
                // covers the other case: an interrupt arriving before the
                // wire was ever pulled has no wake to abort, only a lock to
                // free. Both paths are idempotent.
                opts.interrupt("user", reservationId)
                clearTimeout(abandoned)
                opts.release(reservationId)
            },
        }
    }

    return { stream }
}

export type InvocationT = ReturnType<typeof Invocation>
