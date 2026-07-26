import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { AxonSessionT } from "../session"

type InvocationOpts = {
    session: AxonSessionT
    reserve: () => string
    release: (id?: string) => void
    runWake: (reservationId: string, input: { stimuli: AxonStimulusEntry[] }) => AsyncGenerator<AxonEntry>
    interrupt: (reason: "user" | "shutdown", reservationId?: string) => void
}

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

        const wire = (async function* () {
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
            interrupt: () => opts.interrupt("user", reservationId),
        }
    }

    return { stream }
}

export type InvocationT = ReturnType<typeof Invocation>
