import { state } from "./state"

/**
 * The cortex — the slow, expensive part of the mind.
 *
 * A transcript in, a spoken reply out. This is the only place vox-engine uses
 * a language model, and it is deliberately one verb of ten: the VAD runs
 * every frame, the ASR runs per utterance, and this runs only when there is
 * something worth answering.
 *
 * It never runs in the fast path. An engine call is seconds; the tick budget
 * at 30Hz is 33ms. Awaiting it in the loop would make the brain deaf for the
 * whole reply — unable to hear an interruption, which is precisely the
 * failure that makes voice agents unpleasant to talk to.
 */

/** How much conversation to carry. Enough for context, short enough to stay fast. */
const HISTORY = 12

/**
 * Who this brain is.
 *
 * Deliberately terse output instructions: this text is going to be SPOKEN, and
 * a model that writes bullet points and markdown produces speech nobody wants
 * to listen to. The prompt is the cognet's, not the agent's — the agent's own
 * identity arrives separately through kernel.base().
 */
const IDENTITY = [
    "You are a voice. Everything you say will be spoken aloud.",
    "Reply in one or two short sentences. Never use lists, markdown, or emoji.",
    "If you did not understand, say so plainly and briefly.",
].join(" ")

export type CortexReply = { text: string; ms: number }

/**
 * Answer one utterance.
 *
 * Returns null when the model said nothing worth speaking — which is a real
 * outcome, not a failure: a transcript can be noise, and a voice that
 * responds to everything is worse than one that occasionally stays quiet.
 */
export async function think(transcript: string, signal: AbortSignal): Promise<CortexReply | null> {
    const started = Date.now()

    // The agent's own identity, if it declares one, ahead of the cognet's
    // instructions about being a voice. Base is the USER's contract with
    // their agent; this brain only decides where it sits in the prompt.
    const base = await kernel.base()

    state.history.push({ role: "user", content: transcript })
    if (state.history.length > HISTORY) state.history.splice(0, state.history.length - HISTORY)

    const messages = [
        { role: "system" as const, content: base ? `${base}\n\n${IDENTITY}` : IDENTITY },
        ...state.history,
    ]

    // Read the raw response, not `engine:text`.
    //
    // `engine:text` is an AIR block — it only fires when the model's output
    // PARSES as AIR, the grammar `@axon/zero` uses to interleave prose with
    // executable blocks. A voice agent asks for a plain sentence, nothing
    // parses, and no engine:text is ever emitted: the loop completed and
    // `text` stayed empty, silently.
    //
    // `engine:done` carries the full raw output regardless of grammar, which
    // is exactly right for a cognet that wants what the model said rather
    // than what it structurally meant. Grammar is a cognet's choice; this one
    // has none.
    let text = ""
    for await (const event of kernel.engine("main").stream({ messages, signal })) {
        if (event.type === "engine:done") text = event.response.text
    }

    text = text.trim()
    if (!text) return null

    state.history.push({ role: "assistant", content: text })
    return { text, ms: Date.now() - started }
}
