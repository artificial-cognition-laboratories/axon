export const state = {
    /** Total audio folded since boot, ms — the "am I hearing anything" counter. */
    heardMs: 0,

    /** Speech probability of the most recent frame, 0..1. */
    speech: 0,
    /** Adaptive idle noise estimate used by the local speech gate. */
    noiseFloor: 0.04,


    /**
     * Consecutive frames above/below the speech threshold.
     *
     * Raw per-frame probability flickers; an utterance is a RUN of frames.
     * Counting the run is what turns a noisy signal into "someone started
     * talking" — and it is cognition, which is why it lives in the brain and
     * not in whatever produced the frames.
     */
    speechFrames: 0,
    silenceFrames: 0,

    /** Whether the brain currently believes someone is mid-utterance. */
    speaking: false,

    /**
     * Audio kept for the utterance in progress.
     *
     * The brain CHOOSING to remember. Stimuli are transient — delivered once,
     * then dropped — so nothing upstream is holding these frames. A mind that
     * wants to transcribe what was said has to keep it while it is being
     * said, because by the time the utterance closes the sound is long gone.
     *
     * Bounded, because an open mic with a stuck VAD would otherwise grow
     * forever. Dropping the OLDEST is the right end to lose: the newest audio
     * is the part still being spoken.
     */
    utterance: [] as Int16Array[],

    /**
     * True while a transcription is in flight.
     *
     * Whisper on a few seconds of speech takes ~200-500ms; the tick budget at
     * 30Hz is 33ms. So it runs detached, across many wakes, and this flag is
     * how the fast path avoids starting a second one on top of the first.
     *
     * The kernel offers no primitive for this on purpose — coordinating
     * overlapping wakes is the cognet's own business, and a flag in resident
     * state is the whole mechanism.
     */
    transcribing: false,

    /**
     * The conversation so far — the brain's own record of what was said.
     *
     * Not derived from the session log. Audio stimuli are transient and never
     * committed, so there is nothing in the log to fold: a mind that wants to
     * remember a conversation has to keep it, and this is where it keeps it.
     */
    history: [] as Array<{ role: "user" | "assistant"; content: string }>,

    /**
     * True while the cortex is thinking.
     *
     * An engine call is seconds; a wake is 33ms. Without this, every utterance
     * that landed mid-reply would start a second concurrent call, and the two
     * would answer over each other. The kernel supplies no primitive for this
     * — deciding what to do when someone speaks while you are still replying
     * is a decision about cognition.
     */
    thinking: false,

    /**
     * Aborts the in-flight reply.
     *
     * Barge-in: when the fast path hears speech while the cortex is talking,
     * it fires this. Held here because the wake that STARTED the reply is long
     * gone by the time a later wake decides to stop it.
     */
    replyAbort: null as AbortController | null,
}

/** ~30s at 16kHz — far longer than any real utterance, short enough to bound memory. */
export const MAX_UTTERANCE_FRAMES = 940

/** Reset resident cognition state after a reload or shutdown. */
export function reset(): void {
    state.heardMs = 0
    state.speech = 0
    state.noiseFloor = 0.04
    state.speechFrames = 0
    state.silenceFrames = 0
    state.speaking = false
    state.utterance = []
    state.transcribing = false
    state.history = []
    state.thinking = false
    state.replyAbort = null
    state.interruptions = 0
}

/** Flatten the buffered utterance into one contiguous buffer for the model. */
export function takeUtterance(): Int16Array {
    const frames = state.utterance
    state.utterance = []

    const total = frames.reduce((n, f) => n + f.length, 0)
    const merged = new Int16Array(total)
    let offset = 0
    for (const frame of frames) {
        merged.set(frame, offset)
        offset += frame.length
    }
    return merged
}
