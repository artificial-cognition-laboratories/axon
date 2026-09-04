import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { err } from "@arcforge/err"

/** A canonical WAV header. Every recorder here writes one before any samples. */
const WAV_HEADER_BYTES = 44

/** What a finished recording produced. */
export type Recording = {
    /** Absolute path to the wav. The caller owns deleting it. */
    path: string
    /** Milliseconds of audio, measured from the clock rather than the file. */
    durationMs: number
}

export type CaptureOpts = {
    /** Where wavs are written. Defaults beside the other daemon state. */
    root?: string
    /** Injectable, so a test never needs a microphone. */
    spawnProcess?: typeof spawn
    now?: () => number
}

/**
 * The microphone, as one recording at a time.
 *
 * ── Why a recorder is a daemon concern ──────────────────────────────────────
 *
 * Dictation is two separate keypresses — start and stop — and on a desktop
 * those arrive as two independent processes launched by the compositor. There
 * is no shared memory between them, so SOMETHING resident has to be holding
 * the microphone in between. That is the daemon, and it is the clearest case
 * yet for why this is a daemon rather than a library.
 *
 * ── One recording, never a queue ────────────────────────────────────────────
 *
 * A second `start()` while recording is a mistake, not a second stream: it
 * means a keybind fired twice or the user forgot they were recording. It is
 * refused loudly rather than silently replacing the first, because the failure
 * mode of replacing is losing what someone just said.
 *
 * WAV at 16 kHz mono because that is what every speech model wants and what
 * `pw-record` can produce directly — resampling in the adapter would be work
 * done twice, and the file is deleted seconds later either way.
 */
export function Capture(opts: CaptureOpts = {}) {
    const root = opts.root ?? join(tmpdir(), "axon-dictation")
    const launch = opts.spawnProcess ?? spawn
    const now = opts.now ?? (() => Date.now())

    let child: ChildProcess | null = null
    let path: string | null = null
    let startedAt = 0

    /**
     * The recorder this machine has.
     *
     * PipeWire first because Omarchy runs it, then PulseAudio, then ALSA. Each
     * is asked for the same thing — 16 kHz mono signed 16-bit — so whichever
     * answers, the adapter downstream sees one format.
     */
    function recorder(target: string): string[] | null {
        if (which("pw-record")) return ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", target]
        if (which("parecord")) return ["parecord", "--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", target]
        if (which("arecord")) return ["arecord", "-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "wav", target]
        return null
    }

    return {
        /** True while the microphone is open. */
        get recording(): boolean {
            return child !== null
        },

        /** When the current recording began, epoch ms. Zero when idle. */
        get since(): number {
            return child === null ? 0 : startedAt
        },

        /**
         * The file being written, while one is. Null when idle.
         *
         * Exposed so streaming can read closed segments out of a recording that
         * is still open — the whole point of transcribing while someone talks.
         * Read-only by contract: `stop()` and `cancel()` own its lifetime.
         */
        get path(): string | null {
            return child === null ? null : path
        },

        /** Open the microphone. Throws if one is already open. */
        start(): void {
            if (child !== null) {
                throw err("DICTATION_ALREADY_RECORDING", {
                    detail: "a recording is already in progress — stop it before starting another",
                })
            }

            const target = join(root, `dictation-${now()}.wav`)
            const argv = recorder(target)
            if (!argv) {
                throw err("DICTATION_NO_RECORDER", {
                    detail: "no microphone recorder found — install pipewire (pw-record), pulseaudio (parecord) or alsa-utils (arecord)",
                })
            }

            mkdirSync(dirname(target), { recursive: true })
            const [command, ...args] = argv
            const spawned = launch(command!, args, { stdio: ["ignore", "ignore", "pipe"] })

            /*
             * A recorder that dies mid-take must not leave `recording` true.
             *
             * Otherwise every later start is refused as "already recording"
             * against a process that is gone, and the only way out is
             * restarting the daemon — the exact shape of a bug that reads as
             * "dictation just stopped working".
             */
            spawned.on("exit", () => { if (child === spawned) child = null })

            child = spawned
            path = target
            startedAt = now()
        },

        /**
         * Close the microphone and hand back the audio.
         *
         * SIGINT rather than SIGKILL: every one of these recorders finalises
         * the WAV header on an interrupt, and a killed one leaves a file whose
         * declared length is zero — which decodes to silence rather than
         * failing, so the transcript would come back empty with nothing to
         * explain why.
         */
        async stop(): Promise<Recording> {
            const active = child
            const target = path
            if (active === null || target === null) {
                throw err("DICTATION_NOT_RECORDING", { detail: "nothing is being recorded" })
            }

            const durationMs = now() - startedAt
            child = null
            path = null

            const exited = new Promise<void>(resolve => { active.once("exit", () => resolve()) })
            active.kill("SIGINT")
            await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2000))])
            // Only after the grace period, and only if it is still there.
            if (active.exitCode === null && active.signalCode === null) active.kill("SIGKILL")

            if (!existsSync(target) || statSync(target).size === 0) {
                throw err("DICTATION_NO_AUDIO", {
                    detail: "the recorder produced no audio — check that a microphone is connected and not muted",
                    context: { path: target },
                })
            }

            return { path: target, durationMs: durationMs }
        },

        /**
         * Recent loudness, as `count` values from 0 to 1, oldest first.
         *
         * ── Why the daemon measures this and the panel does not ─────────────
         *
         * A visualiser needs to know how loud the room is. The panel could open
         * its own capture to find out — and would then be a SECOND consumer of
         * a microphone that is already being recorded, with its own device
         * handle, its own failure modes, and no guarantee the two agree. The
         * daemon is already writing the samples; reading them back is free.
         *
         * ── Why an array and not one number ─────────────────────────────────
         *
         * The state stream ticks every 500ms and a voice meter that moved twice
         * a second would read as broken. Returning the recent WINDOW means each
         * tick carries real sub-tick detail, so the visualiser draws measured
         * audio rather than an animation interpolated between two samples. Same
         * reason the resource charts take a series rather than a reading.
         *
         * Silence is a real answer: an empty array means the file has no
         * samples yet, which happens for the first few milliseconds and must
         * not be drawn as a spike.
         */
        levels(count = 24): number[] {
            const target = path
            if (target === null || !existsSync(target)) return []

            // 16-bit mono at 16 kHz — the format `recorder()` asks every
            // backend for, so two bytes is one sample and the arithmetic below
            // does not have to care which one answered.
            const bytesPerSample = 2
            const windowSamples = 320 // 20ms at 16 kHz
            const wanted = count * windowSamples * bytesPerSample

            let buffer: Buffer
            try {
                const size = statSync(target).size
                // Never read the 44-byte header as audio: at the very start of
                // a recording it is most of the file, and interpreting it as
                // samples draws a burst of noise before anyone has spoken.
                const available = Math.max(0, size - WAV_HEADER_BYTES)
                if (available < bytesPerSample) return []
                const length = Math.min(wanted, available)
                const start = size - length
                const handle = openSync(target, "r")
                try {
                    buffer = Buffer.alloc(length)
                    readSync(handle, buffer, 0, length, start)
                } finally {
                    closeSync(handle)
                }
            } catch {
                // The file is being written by another process; a torn read is
                // a frame of the meter, not a failure worth reporting.
                return []
            }

            const out: number[] = []
            const perWindow = Math.max(1, Math.floor(buffer.length / bytesPerSample / count))
            for (let index = 0; index < count; index++) {
                let sum = 0
                let seen = 0
                for (let sample = 0; sample < perWindow; sample++) {
                    const at = (index * perWindow + sample) * bytesPerSample
                    if (at + 1 >= buffer.length) break
                    const value = buffer.readInt16LE(at) / 32768
                    sum += value * value
                    seen++
                }
                if (seen === 0) break
                // RMS, then a gentle curve: speech sits low in a linear scale
                // and a meter that only moves for a shout is not a meter.
                out.push(Math.min(1, Math.sqrt(sum / seen) * 3))
            }
            return out
        },

        /** Abandon a recording without transcribing it. Safe when nothing is running. */
        cancel(): void {
            const active = child
            const target = path
            child = null
            path = null
            if (active) active.kill("SIGINT")
            if (target) rmSync(target, { force: true })
        },
    }
}

export type CaptureT = ReturnType<typeof Capture>

function which(binary: string): boolean {
    return Bun.which(binary) !== null
}
