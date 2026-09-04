import { rmSync, statSync } from "node:fs"
import { err } from "@arcforge/err"
import { Capture, type CaptureT } from "./capture"
import { Inject, type InjectT } from "./inject"
import { Keybind, type KeybindT } from "./keybind"
import { Segments, type SegmentsT } from "./segments"
import { socketCommand } from "../control/paths"

/** What the daemon can say about dictation without being asked to do anything. */
export type DictationState = {
    /** True while the microphone is open. */
    recording: boolean
    /** Epoch ms the current recording began. Null when idle. */
    since: number | null
    /** The model that will transcribe, or null when none is chosen or usable. */
    model: string | null
    /** The bound chord, exactly as the compositor spells it. Empty when unbound. */
    hotkey: string
    /** "hold" or "toggle". */
    mode: string
    /**
     * What has been COMMITTED — typed, settled, and never revised.
     *
     * Two consecutive passes agreed on every word here, so it is safe to have
     * already sent to the cursor. Empty while idle.
     */
    partial: string
    /**
     * Recent loudness while recording, 0..1, oldest first. Empty when idle.
     *
     * A window rather than one reading, because the stream ticks twice a second
     * and a meter that moved at that rate would read as broken. The visualiser
     * draws MEASURED audio between ticks instead of interpolating.
     */
    levels: number[]
    /**
     * Why dictation cannot run right now, or null when it can.
     *
     * One field rather than three booleans: the panel shows ONE line, and the
     * first missing thing is the only one worth acting on — telling someone
     * their model is unset and their typist is missing makes them fix two
     * things when the first was enough.
     */
    blocked: string | null
}

/** What one completed dictation produced. */
export type Dictated = {
    text: string
    durationMs: number
    model: string
}

export type DictationOpts = {
    /** Where a transcript comes from. The models domain, so a weight is loaded once and shared. */
    models: {
        run(input: { model: string; input: unknown }): Promise<unknown>
        /** `state()` rather than a bare list: it is the domain's own read, and it corrects residency on the way out. */
        state(): { cached: ReadonlyArray<{ id: string; in: readonly string[]; out: readonly string[] }> }
    }
    /** Where the chosen model, chord and mode live. */
    preferences: {
        text(key: string, fallback: string): string
        set(input: { key: string; value: boolean | string }): boolean | string
    }
    capture?: CaptureT
    inject?: InjectT
    keybind?: KeybindT
    segments?: SegmentsT
}

/**
 * Dictation — speak, and the words are typed where your cursor is.
 *
 * ── Why this is a daemon domain ─────────────────────────────────────────────
 *
 * It is the clearest example of what the daemon is FOR. Every piece needs
 * something no single process can hold: the microphone stays open across two
 * independent keypresses launched by the compositor, the speech model must
 * already be resident or the first word is lost to a cold load, and the whole
 * thing has to work when no terminal and no editor are open. A library cannot
 * do any of that, and an app that could would be an app you have to keep
 * running.
 *
 * ── The whole feature has no surface ────────────────────────────────────────
 *
 * There is no window, no indicator to click, no chat box. A key is pressed,
 * words appear in whatever already had focus. That is the panel's design law
 * held to its limit — the panel shows state, the system does work — and it is
 * why dictation belongs in the same product as a model manager rather than
 * being a separate app: local models as an OS capability, not an application.
 *
 * ── Nothing is retried, and nothing is queued ───────────────────────────────
 *
 * A failed transcription is not attempted again and a second recording is
 * refused while one is open. Speech is live: a retry types words the person
 * has stopped meaning, and a queue types them somewhere they were not looking.
 * Failing immediately and loudly is the only behaviour that respects that.
 */
/**
 * How often a closed segment is looked for.
 *
 * Every millisecond here lands in the delay between finishing a phrase and
 * seeing it typed, so this is deliberately tight. The check is an RMS pass
 * over audio already in the page cache.
 */
const PUMP_MS = 100

export function Dictation(opts: DictationOpts) {
    const capture = opts.capture ?? Capture()
    const inject = opts.inject ?? Inject()
    const segments = opts.segments ?? Segments()

    /**
     * -- Streaming --------------------------------------------------------
     *
     * Transcribing at the end makes the wait scale with how long you spoke:
     * every second of speech is a second of work saved up for the moment you
     * least want to wait. So segments are transcribed AS they close, and the
     * only thing left when the key is released is the tail.
     *
     * Whisper cannot stream. What it can do is transcribe a SEGMENT, and a
     * pause is the one boundary safe to cut on -- `Segments` finds them from
     * the RMS the level meter already computes, so it costs no extra decoding.
     *
     * Plain locals rather than a leaf: this is the bookkeeping of one
     * recording, reset by `start()`, and a module for it would be a noun with
     * no concern of its own.
     */
    let cursor = 0
    let done: string[] = []
    let pumping = false
    let pump: ReturnType<typeof setInterval> | null = null
    /** True once anything has been typed for this recording — decides the leading space. */
    let typedAny = false


    function reset(): void {
        cursor = 0
        done = []
        typedAny = false
        if (pump !== null) { clearInterval(pump); pump = null }
    }

    /**
     * Type one finished phrase, as soon as it exists.
     *
     * ── Why this is safe here and is not, generally ─────────────────────────
     *
     * Typing before the end is only correct if the text will never be revised,
     * and for most streaming recognisers it will be: a sliding window improves
     * its guess as more audio arrives, so anything already typed has to be
     * backspaced and rewritten. That is where incremental dictation gets ugly,
     * and it is why plenty of tools do not attempt it.
     *
     * `Segments` closes a segment only after observing the pause that follows
     * it, so what comes back is final by construction — the model has already
     * seen every sample it will ever see for that phrase. Nothing is ever
     * revised, so nothing ever has to be unwritten. The pause-boundary design
     * was chosen for accuracy; this is the second thing it buys.
     *
     * The failure mode worth naming: if focus moves mid-dictation, the rest
     * lands in the new window. Every dictation tool has that, it is what the
     * person asked for by clicking, and guarding it would mean holding text
     * back — which is the behaviour this exists to remove.
     */
    async function emit(text: string): Promise<void> {
        const body = text.trim()
        if (body === "") return
        // Marked BEFORE awaiting: two phrases finishing close together must
        // not both decide they are the first and land without a space between.
        const first = !typedAny
        typedAny = true
        await inject.type(first ? body : ` ${body}`)
    }

    /** Transcribe one closed segment, if one has closed. Never runs twice at once. */
    /**
     * Transcribe a phrase as soon as its pause proves it finished.
     *
     * This is the whole of streaming now, and the ONLY model pass per phrase.
     * `pumping` guards it: a pass never starts while one is running, so a slow
     * runtime degrades to fewer updates rather than to a queue.
     */
    async function drain(model: string, path: string): Promise<void> {
        if (pumping) return
        pumping = true
        try {
            /*
             * A closed segment is AUTHORITATIVE and ends the buffer.
             *
             * It is the one pass that has heard the pause on both sides, so it
             * is the best reading of that phrase there will be. Anything
             * already committed from a hypothesis stays — it cannot be
             * unwritten — and only the words beyond it are emitted.
             */
            const segment = segments.next(path, cursor)
            if (segment !== null) {
                const target = `${path}.${segment.from}.wav`
                segments.slice(path, segment, target)
                // Advance BEFORE the model runs. A pass that throws must not
                // leave the cursor behind it, or the same audio is retried
                // forever and the stream stalls on one bad segment.
                cursor = segment.to
                try {
                    const text = transcript(await opts.models.run({ model: model, input: target }))
                    if (text !== "") {
                        done.push(text)
                        // Typed NOW rather than saved for the end: the phrase is
                        // final, and watching words appear is the difference
                        // between dictation that feels live and one that feels
                        // broken.
                        await emit(text)
                    }
                } finally {
                    rmSync(target, { force: true })
                }
                return
            }

            /*
             * -- No hypothesis passes. --------------------------------------
             *
             * LocalAgreement was built here and taken out again, and the reason
             * is worth keeping: it re-transcribes the open buffer on every
             * pass, and ONNX inference is CPU-bound work inside THIS process.
             * The daemon is single-threaded, so every pass froze the event loop
             * for one to two seconds — which starved the 16Hz level stream, and
             * the listening indicator went stale and vanished mid-sentence
             * because no frame had arrived for two seconds.
             *
             * The arithmetic was already against it: passes cost ~900ms fixed
             * against a cadence that wants ~400ms. What was not obvious until
             * it ran is that the COST of being over budget lands on the parts
             * of the product that were working, not on the feature that is
             * late. It needs a runtime that is out of process or much faster,
             * and it has neither today.
             *
             * So the stable shape is what it was before: transcribe a phrase
             * when its pause proves it finished. Text is still typed while you
             * speak, one phrase behind rather than one word behind.
             */
        } catch {
            /*
             * A failed pass is DROPPED, not retried and not fatal.
             *
             * The recording is still open and the person is still talking;
             * abandoning a dictation over one pass that would not decode is
             * worse than losing it. `stop()` still fails loudly if the final
             * pass fails.
             */
        } finally {
            pumping = false
        }
    }
    /*
     * The ABSOLUTE path to the CLI, never a bare `axon`.
     *
     * A compositor keybind runs with the graphical session's PATH, which does
     * not contain the directory the CLI installs to — so `axon daemon dictate`
     * resolved to nothing and the keypress did what a typo does: silence. Same
     * trap the systemd unit hit twice; `cliPath()` is the one answer to it.
     */
    /*
     * The keypress talks to the socket, not to the CLI.
     *
     * `axon daemon dictate start` measured 650ms, essentially all of it loading
     * a 25MB bundle to write one line — paid twice per dictation, by every
     * user, built or not. The same call over the daemon's own HTTP-on-unix
     * protocol is 5ms.
     */
    const keybind = opts.keybind ?? Keybind({
        command: verb => socketCommand(["dictation", verb === "toggle" ? "toggle" : verb]),
    })

    /**
     * Which model transcribes.
     *
     * The chosen one when it is still installed and still takes audio, and
     * otherwise the first that is — a model can be deleted after being chosen,
     * and refusing to work until someone revisits a settings page they may not
     * remember setting is worse than using the one that will obviously do.
     * Null when nothing on this machine can transcribe at all.
     */
    async function model(): Promise<string | null> {
        const usable = opts.models.state().cached
            .filter(record => record.in.includes("audio") && record.out.includes("text"))
        const chosen = opts.preferences.text("dictation.model", "")
        if (chosen !== "" && usable.some(record => record.id === chosen)) return chosen
        return usable.length > 0 ? usable[0]!.id : null
    }

    /** The first thing standing in the way, or null. Order is fix-this-first. */
    async function blocked(): Promise<string | null> {
        if (!inject.available) return "wtype is not installed — it types the transcript into the focused window"
        if ((await model()) === null) return "no speech-recognition model is downloaded — install one under Audio"
        return null
    }

    /**
     * The transcript, out of whatever the adapter returned.
     *
     * transformers.js answers `{ text }` for recognition, but `plain()`
     * normalises tensors and the shape has moved before. A string, a `text`
     * field, or the first element of a chunk list are the three it has
     * actually produced — anything else throws rather than typing "[object
     * Object]" into someone's editor.
     */
    function transcript(result: unknown): string {
        if (typeof result === "string") return result.trim()
        if (result && typeof result === "object") {
            const text = (result as { text?: unknown }).text
            if (typeof text === "string") return text.trim()
            if (Array.isArray(result) && typeof (result[0] as { text?: unknown } | undefined)?.text === "string") {
                return String((result[0] as { text: string }).text).trim()
            }
        }
        throw err("DICTATION_NO_TRANSCRIPT", {
            detail: `the model returned no readable text (${typeof result})`,
            context: { shape: typeof result },
        })
    }

    return {
        async state(): Promise<DictationState> {
            return {
                recording: capture.recording,
                since: capture.recording ? capture.since : null,
                model: await model(),
                hotkey: opts.preferences.text("dictation.hotkey", ""),
                mode: opts.preferences.text("dictation.mode", "hold"),
                levels: capture.recording ? capture.levels() : [],
                partial: capture.recording ? done.join(" ") : "",
                blocked: await blocked(),
            }
        },

        /**
         * Open the microphone.
         *
         * Everything that could refuse is checked HERE rather than at stop:
         * discovering there is no model after someone has spoken a paragraph
         * means the paragraph is gone. Better to refuse the keypress.
         */
        async start(): Promise<DictationState> {
            const reason = await blocked()
            if (reason !== null) {
                throw err("DICTATION_UNAVAILABLE", { detail: reason })
            }
            // Resolved once, at the start. A model chosen mid-recording would
            // transcribe half an utterance with one and half with another.
            const chosen = await model()
            if (chosen === null) throw err("DICTATION_UNAVAILABLE", { detail: "no speech-recognition model is available" })
            reset()
            capture.start()

            /*
             * The pump starts with the recording, not with the first pause.
             *
             * It polls for a CLOSED segment rather than being told about one:
             * the recorder is another process writing a file, and there is no
             * event to subscribe to.
             *
             * 100ms, not 500. The poll sits directly in the latency a person
             * feels — a phrase is finished, confirmed, and then waits for the
             * next tick before anything starts — so at 500ms it was adding up
             * to half a second of pure nothing to every phrase. The work it
             * does is an RMS pass over audio already in page cache, which is
             * far too cheap to be worth spacing out.
             */
            const path = capture.path
            if (path !== null) {
                pump = setInterval(() => { void drain(chosen, path) }, PUMP_MS)
            }
            return this.state()
        },

        /** Close the microphone, transcribe, and type it. */
        async stop(): Promise<Dictated> {
            const chosen = await model()
            if (chosen === null) {
                capture.cancel()
                throw err("DICTATION_UNAVAILABLE", {
                    detail: "no speech-recognition model is downloaded — install one under Audio",
                })
            }

            // Stop the pump BEFORE closing the file, so a segment pass cannot
            // start against a recording that is about to be deleted.
            if (pump !== null) { clearInterval(pump); pump = null }
            const recording = await capture.stop()

            try {
                /*
                 * Only the TAIL is transcribed here.
                 *
                 * Everything before the last pause was already done while the
                 * person was speaking, so the wait at the end is bounded by
                 * one segment rather than by how long they talked. That is the
                 * entire point of streaming, and it is why this reads the
                 * cursor instead of the whole file.
                 *
                 * Skipped when the tail is silence — which it usually is, being
                 * the moment between finishing a sentence and letting go of the
                 * key. Sending that to Whisper is exactly how "you" and "Thank
                 * you." get typed into an editor: the model confabulates rather
                 * than returning nothing.
                 */
                if (segments.hasSpeech(recording.path, cursor)) {
                    const tail = `${recording.path}.tail.wav`
                    segments.slice(recording.path,
                        { from: Math.max(cursor, 44), to: statSync(recording.path).size, durationMs: 0 }, tail)
                    try {
                        const text = transcript(await opts.models.run({ model: chosen, input: tail }))
                        if (text !== "") {
                            done.push(text)
                            await emit(text)
                        }
                    } finally {
                        rmSync(tail, { force: true })
                    }
                }

                /*
                 * Everything has already been typed, phrase by phrase.
                 *
                 * This is only the RECORD of what was said — what the verb
                 * returns and what a caller logs. Typing it again here is the
                 * bug that shape invites, and it would double every dictation.
                 *
                 * Whisper puts a leading space on every segment; joined raw
                 * that becomes a double space at every pause.
                 */
                const text = done.map(part => part.trim()).filter(part => part !== "").join(" ")
                return { text: text, durationMs: recording.durationMs, model: chosen }
            } finally {
                reset()
                // The audio is deleted whatever happened. It is a recording of
                // someone's voice: keeping it around for diagnostics would be
                // a surveillance surface nobody asked for, and it can always
                // be reproduced by speaking again.
                rmSync(recording.path, { force: true })
            }
        },

        /**
         * Start if idle, stop if recording — what ONE keybind runs.
         *
         * Toggle mode binds a single key to this. Hold mode binds press to
         * `start` and release to `stop`, so it does not go through here — but
         * the daemon holding the state is what makes both spellings possible
         * from a compositor that only knows how to launch processes.
         */
        async toggle(): Promise<{ recording: boolean; dictated: Dictated | null }> {
            if (capture.recording) {
                return { recording: false, dictated: await this.stop() }
            }
            await this.start()
            return { recording: true, dictated: null }
        },

        /** Throw the current recording away without transcribing it. */
        cancel(): void {
            reset()
            capture.cancel()
        },

        /**
         * Register the chord with the compositor, from the stored preference.
         *
         * Called at daemon start and whenever the setting changes. Idempotent:
         * the previous binding on that chord is removed first, so re-applying
         * is always safe and switching between hold and toggle never leaves
         * both shapes bound at once.
         *
         * Unbound is a REAL state, not a failure — someone who has not chosen a
         * chord has not misconfigured anything, so this returns quietly rather
         * than throwing at every daemon start.
         */
        bind(): { chord: string; mode: string; bound: boolean } {
            const chord = opts.preferences.text("dictation.hotkey", "")
            const mode = opts.preferences.text("dictation.mode", "hold")
            if (!keybind.available) return { chord: chord, mode: mode, bound: false }

            /*
             * The PREVIOUS chord is cleared, not the current one.
             *
             * `apply()` already removes anything on the chord it is about to
             * bind, which covers a re-bind of the same keys. It cannot cover a
             * CHANGE: rebinding SUPER+ALT+D to SUPER+ALT+K left D bound and
             * running dictation forever, with nothing in the panel admitting
             * it existed. So what was last bound is remembered — in the
             * preferences file, because the binding outlives this process and
             * an in-memory note would be lost across the restart that
             * re-applies it.
             */
            const previous = opts.preferences.text("dictation.bound", "")
            if (previous !== "" && previous !== chord) keybind.clear(previous)

            if (chord === "") {
                opts.preferences.set({ key: "dictation.bound", value: "" })
                return { chord: chord, mode: mode, bound: false }
            }

            keybind.apply({ chord: chord, mode: mode })
            opts.preferences.set({ key: "dictation.bound", value: chord })
            return { chord: chord, mode: mode, bound: true }
        },

        /** Remove the chord from the compositor. */
        unbind(): void {
            for (const key of ["dictation.bound", "dictation.hotkey"]) {
                const chord = opts.preferences.text(key, "")
                if (chord !== "") keybind.clear(chord)
            }
            opts.preferences.set({ key: "dictation.bound", value: "" })
        },
    }
}

export type DictationT = ReturnType<typeof Dictation>
