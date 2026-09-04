import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs"

/** 16 kHz mono signed 16-bit — what `Capture` asks every backend for. */
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const WAV_HEADER_BYTES = 44

/** One stretch of speech, as a byte range in the recording. */
export type Segment = {
    /** Byte offset into the WAV, header included. */
    from: number
    to: number
    /** Milliseconds of audio it covers. */
    durationMs: number
}

export type SegmentsOpts = {
    /**
     * RMS below this is silence. 0..1.
     *
     * Deliberately low. The cost of splitting a sentence in the middle is a
     * word transcribed without its context; the cost of never splitting is
     * that streaming does nothing. A quiet room measures around 0.005 here.
     */
    silence?: number
    /**
     * How much continuous quiet ends a segment.
     *
     * Sits directly in the felt latency: nothing can be typed until the pause
     * that proves a phrase ended has been observed. 400ms is chosen against
     * how people actually speak — a pause BETWEEN sentences runs 500ms to a
     * second, while a breath inside one is nearer 200-300ms — so it is below
     * the boundary being detected and above the one that must not be.
     *
     * Lowering it further starts cutting mid-sentence. That is not fatal (the
     * text is append-only, so a fragment is still typed in the right place)
     * but the model loses the context either side of the cut, and the words at
     * the boundary get worse.
     */
    silenceMs?: number
    /** A segment shorter than this is not worth a model pass. */
    minSpeechMs?: number
    /**
     * How much of a segment must be above the floor for it to BE speech, 0..1.
     *
     * A threshold alone is not enough. A keyboard click clears any sensible
     * amplitude floor and lasts about fifty milliseconds, so silence
     * punctuated by typing looks exactly like speech to a level test — and
     * Whisper, handed it, confabulates. Measured: six seconds of a quiet room
     * with typing produced "you you".
     *
     * Speech has a duty cycle. Someone talking is above the floor most of the
     * time; a room with occasional noise is above it a few percent of the time.
     * That gap is large, robust, and cheap — and it is a property of the
     * SIGNAL, unlike a blocklist of whichever words a model tends to invent.
     */
    voiced?: number
    /**
     * Force a cut after this much speech even with no pause.
     *
     * Someone who does not breathe would otherwise accumulate the whole
     * recording into one segment and defeat the streaming entirely.
     */
    maxSpeechMs?: number
}

/**
 * Where speech starts and stops inside a recording still being written.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Transcribing at the end means the wait scales with how long you spoke: every
 * second of speech is a second of work saved up for the moment you most want
 * an answer. Streaming moves that work under the speaking, so the only thing
 * left at the end is the tail.
 *
 * Whisper is not a streaming model and cannot be made into one. What it can do
 * is transcribe a SEGMENT, so the job here is finding boundaries that are safe
 * to cut on — and a pause is the only safe one. Cutting on a fixed clock would
 * slice words in half, and a word split across two passes is transcribed wrong
 * in both.
 *
 * ── Why silence detection is free ───────────────────────────────────────────
 *
 * `Capture` already computes RMS windows for the level meter. This reads the
 * same audio the same way, so segmentation costs no extra decoding — and it
 * incidentally fixes the confabulation-on-silence problem, because a segment
 * that never rose above the floor is never sent to the model at all.
 */
export function Segments(opts: SegmentsOpts = {}) {
    const silence = opts.silence ?? 0.02
    const silenceMs = opts.silenceMs ?? 400
    const minSpeechMs = opts.minSpeechMs ?? 700
    const voiced = opts.voiced ?? 0.3
    const maxSpeechMs = opts.maxSpeechMs ?? 12000

    /** 20ms of audio, the same window the meter uses. */
    const windowSamples = 320
    const windowBytes = windowSamples * BYTES_PER_SAMPLE
    const windowMs = (windowSamples / SAMPLE_RATE) * 1000

    function bytesToMs(bytes: number): number {
        return (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000
    }

    /** The share of windows above the floor — a duty cycle, not a peak. */
    function ratio(levels: readonly number[]): number {
        if (levels.length === 0) return 0
        let loud = 0
        for (const level of levels) if (level >= silence) loud++
        return loud / levels.length
    }

    /** RMS per 20ms window across a byte range. Empty when the range has no audio. */
    function windows(path: string, from: number, to: number): number[] {
        const length = to - from
        if (length < windowBytes) return []
        let buffer: Buffer
        const handle = openSync(path, "r")
        try {
            buffer = Buffer.alloc(length)
            readSync(handle, buffer, 0, length, from)
        } finally {
            closeSync(handle)
        }

        const out: number[] = []
        for (let at = 0; at + windowBytes <= buffer.length; at += windowBytes) {
            let sum = 0
            for (let sample = 0; sample < windowSamples; sample++) {
                const value = buffer.readInt16LE(at + sample * BYTES_PER_SAMPLE) / 32768
                sum += value * value
            }
            out.push(Math.sqrt(sum / windowSamples))
        }
        return out
    }

    return {
        /**
         * The next complete segment after `from`, or null if none has closed yet.
         *
         * A segment is CLOSED only when the pause after it has been observed —
         * so this never returns audio someone is still in the middle of saying.
         * That is the whole contract: everything it hands back is safe to
         * transcribe and will not be revised.
         */
        next(path: string, from: number): Segment | null {
            let size: number
            try {
                size = statSync(path).size
            } catch {
                return null
            }
            const start = Math.max(from, WAV_HEADER_BYTES)
            if (size - start < windowBytes) return null

            const levels = windows(path, start, size)
            if (levels.length === 0) return null

            const quietWindows = Math.ceil(silenceMs / windowMs)
            const minWindows = Math.ceil(minSpeechMs / windowMs)
            const maxWindows = Math.ceil(maxSpeechMs / windowMs)

            let speechFrom = -1
            let quiet = 0

            for (let index = 0; index < levels.length; index++) {
                const loud = levels[index]! >= silence

                if (loud) {
                    if (speechFrom === -1) speechFrom = index
                    quiet = 0
                } else if (speechFrom !== -1) {
                    quiet++
                }

                if (speechFrom === -1) continue
                const spoken = index - speechFrom + 1

                const closes = (quiet >= quietWindows && spoken - quiet >= minWindows)
                    // Someone who does not pause still gets segmented, or
                    // streaming silently degrades to transcribe-at-the-end.
                    || spoken >= maxWindows
                if (!closes) continue

                const body = levels.slice(speechFrom, index + 1)
                /*
                 * A candidate that is mostly quiet is NOISE, and is skipped
                 * rather than transcribed.
                 *
                 * Typing, a fan knock, a door — each clears the amplitude floor
                 * for a few windows and, spread across a quiet minute, keeps
                 * resetting the pause counter until something "closes". Handed
                 * to Whisper that produces invented words: measured, six
                 * seconds of a quiet room with typing came back "you you".
                 *
                 * Skipping ADVANCES past it — returning null would re-examine
                 * the same audio forever and stall the stream on a cough.
                 */
                if (ratio(body) < voiced) {
                    speechFrom = -1
                    quiet = 0
                    continue
                }

                const to = start + (index + 1) * windowBytes
                return {
                    from: start + speechFrom * windowBytes,
                    to: to,
                    durationMs: bytesToMs(to - (start + speechFrom * windowBytes)),
                }
            }
            return null
        },

        /**
         * True when a byte range contains speech at all.
         *
         * The tail at `stop()` is usually the last few hundred milliseconds
         * after someone stopped talking. Sending pure silence to Whisper is how
         * "you" and "Thank you." get typed into an editor — the model
         * confabulates rather than returning nothing — so a range that never
         * rose above the floor is skipped instead.
         */
        hasSpeech(path: string, from: number, to?: number): boolean {
            let end = to
            if (end === undefined) {
                try {
                    end = statSync(path).size
                } catch {
                    return false
                }
            }
            const levels = windows(path, Math.max(from, WAV_HEADER_BYTES), end)
            // Duty cycle, not "any window was loud" — see `voiced`. The tail is
            // usually the moment between finishing a sentence and letting go of
            // the key, and a single keystroke in it must not count as speech.
            return ratio(levels) >= voiced
        },

        /**
         * Write a byte range out as a standalone WAV.
         *
         * A fresh 44-byte header rather than a copy of the original's: the
         * source header declares the length of the WHOLE recording, and a slice
         * carrying it would claim to be minutes long and decode as mostly
         * silence — which Whisper would dutifully transcribe as nothing, with
         * no error anywhere to explain the empty result.
         */
        slice(path: string, segment: Segment, target: string): void {
            const length = segment.to - segment.from
            const audio = Buffer.alloc(length)
            const handle = openSync(path, "r")
            try {
                readSync(handle, audio, 0, length, segment.from)
            } finally {
                closeSync(handle)
            }

            const header = Buffer.alloc(WAV_HEADER_BYTES)
            header.write("RIFF", 0)
            header.writeUInt32LE(36 + length, 4)
            header.write("WAVE", 8)
            header.write("fmt ", 12)
            header.writeUInt32LE(16, 16)          // PCM chunk size
            header.writeUInt16LE(1, 20)           // PCM
            header.writeUInt16LE(1, 22)           // mono
            header.writeUInt32LE(SAMPLE_RATE, 24)
            header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28) // byte rate
            header.writeUInt16LE(BYTES_PER_SAMPLE, 32)               // block align
            header.writeUInt16LE(16, 34)          // bits per sample
            header.write("data", 36)
            header.writeUInt32LE(length, 40)

            writeFileSync(target, Buffer.concat([header, audio]))
        },
    }
}

export type SegmentsT = ReturnType<typeof Segments>
