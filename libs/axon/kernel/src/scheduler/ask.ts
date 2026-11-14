import { addressedTo, type AxonEntry, type AxonStimulusInput } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import type { KernelBus } from "../contracts"
import { Channel } from "./channel"
import { isEntry } from "./entry"

type AskInput = {
    content?: string | string[]
    stimuli?: AxonStimulusInput[]
    /** The surface the message arrived on — the address the mind answers to. */
    channel?: string
}

/**
 * Ask — a request, made of a mind that has no requests.
 *
 * A continuous mind runs on its own clock and hears whatever it is sent, so
 * nothing about it begins or ends with a message. A caller that wants an
 * answer — `axon -p`, an API, another agent — still gets one: the message is
 * admitted, the entries the mind commits for this caller's channel (or for
 * no one) stream back as they land, and the stream ends when the mind has
 * SETTLED the message — every system that reads stimuli has taken it, and
 * every run that took it, and whatever that run started, has ended. The mind
 * says so itself (`cognet:settled`), by the seq it received each stimulus at.
 *
 * Nothing is reserved, and nothing is locked: the mind keeps ticking, other
 * clients keep talking, and a caller that walks away leaves nothing held.
 */
export function Ask(opts: { session: AxonSessionT; bus: KernelBus; interrupt: (reason: "user") => void }) {
    /** Callers waiting on a stimulus, by the seq the mind received it at. */
    const waiting = new Map<number, () => void>()

    return {
        /** The mind is done with these stimuli. */
        settled(seqs: readonly number[]): void {
            for (const seq of seqs) {
                waiting.get(seq)?.()
                waiting.delete(seq)
            }
        },

        stream(input: AskInput) {
            const channel = input.channel ?? "terminal"
            const asked: number[] = []

            const wire = (async function* () {
                const out = Channel<AxonEntry>()
                const unsubscribe = opts.bus.onAny((_type, payload) => {
                    if (!isEntry(payload)) return
                    if (!addressedTo(payload.data, channel)) return
                    out.push(payload)
                })
                try {
                    // Each waited on the moment it is admitted: the mind may settle the first while a later one is still going in.
                    const settling: Array<Promise<void>> = []
                    const admitted = (seq: number) => {
                        asked.push(seq)
                        settling.push(new Promise<void>(resolve => waiting.set(seq, resolve)))
                    }
                    const contents = input.content === undefined ? [] : Array.isArray(input.content) ? input.content : [input.content]
                    for (const content of contents) admitted((await opts.session.stimuli.ingest("cognet:stimulus:text", { channel: channel, content: content })).time.seq)
                    for (const stimulus of input.stimuli ?? []) admitted((await opts.session.stimuli.ingest(stimulus.type, stimulus.data as never)).time.seq)
                    void Promise.all(settling).then(() => out.close())
                    yield* out
                } finally {
                    unsubscribe()
                    for (const seq of asked) waiting.delete(seq)
                }
            })()

            return { stream: wire, interrupt: () => opts.interrupt("user") }
        },
    }
}

export type AskT = ReturnType<typeof Ask>
