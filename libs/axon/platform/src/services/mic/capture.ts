/**
 * capture — owns the audio capture child process and the raw PCM byte
 * stream. Two consumers of the same bytes: the full accumulated recording
 * (for STT, wrapped as a real WAV file on stop) and a rolling window of
 * the most recent samples (for the FFT tick to read from).
 *
 * Detects whichever capture tool is ALREADY on the machine — arecord
 * (ships with ALSA, essentially always present on Linux), sox, or ffmpeg
 * — and uses the first one found. This never installs anything itself:
 * shelling `sudo apt-get install` from inside a running TUI means a
 * password prompt fighting VTerm's own raw terminal mode for control,
 * which is both a bad user-trust story and, in practice, garbles the
 * screen. If none of the three exist, this fails loudly with a clear
 * "install one of these" message — the same honest failure mode, just
 * without ever mutating the user's system on their behalf.
 */
import { err } from "@arcforge/err"

type CaptureBackend = "arecord" | "sox" | "ffmpeg"

export type CaptureOpts = {
    sampleRate: number
    /** Rolling window length in samples — must cover at least one FFT frame. */
    windowSamples: number
}

/**
 * Capture backends worth trying, in priority order, for one platform.
 *
 * Split from the $PATH probe and given the platform as a PARAMETER so all
 * three orders are assertable from one machine. The darwin and win32 lists
 * cannot execute on Linux CI otherwise, which is how a wrong argv ships: the
 * failure is a silent "voice unavailable", indistinguishable from a machine
 * that genuinely has no capture tool installed.
 */
export function backendsFor(platform: NodeJS.Platform = process.platform): CaptureBackend[] {
    // Windows has no reliable always-present CLI capture tool, so sox/ffmpeg
    // only. macOS likewise — arecord is ALSA, which is Linux's.
    if (platform === "darwin" || platform === "win32") return ["sox", "ffmpeg"]
    return ["arecord", "sox", "ffmpeg"] // linux and other unix
}

/** First backend actually present on $PATH, or null when none is. */
function detectBackend(): CaptureBackend | null {
    for (const cmd of backendsFor()) {
        if (Bun.which(cmd)) return cmd
    }
    return null
}

/**
 * Spawn args per backend — all produce raw signed 16-bit LE PCM, mono, at
 * `sampleRate`, on stdout. Every branch ends in that same format, which is the
 * invariant the reader downstream depends on.
 *
 * The platform is a PARAMETER, not a `process.platform` read, so the six
 * OS-specific argv shapes can be asserted on any machine. Each names a
 * different audio subsystem — avfoundation on macOS, dshow on Windows, ALSA on
 * Linux — and getting one wrong yields a backend that spawns and then produces
 * nothing, which reads to the user as a microphone that does not work.
 */
export function buildArgs(
    backend: CaptureBackend,
    sampleRate: number,
    platform: NodeJS.Platform = process.platform,
): string[] {
    const rate = String(sampleRate)

    if (backend === "arecord") {
        // ALSA only — never selected on darwin or win32 (see backendsFor).
        return ["-t", "raw", "-f", "S16_LE", "-r", rate, "-c", "1", "-"]
    }

    if (backend === "sox") {
        // `-d` is sox's default input device, which both macOS and Windows
        // resolve themselves. Linux needs the ALSA device named explicitly.
        if (platform === "darwin" || platform === "win32") {
            return ["-d", "-r", rate, "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-"]
        }
        return ["-t", "alsa", "default", "-r", rate, "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-"]
    }

    // ffmpeg — one flag per platform's capture subsystem.
    if (platform === "darwin") {
        return ["-f", "avfoundation", "-i", ":0", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
    }
    if (platform === "win32") {
        return ["-f", "dshow", "-i", "audio=default", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
    }
    return ["-f", "alsa", "-i", "default", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
}

export function Capture(opts: CaptureOpts) {
    let proc: ReturnType<typeof Bun.spawn> | null = null
    /**
     * Typed by what is consumed, not by whose ReadableStream this is.
     *
     * Bun's global `ReadableStreamDefaultReader` carries `readMany`; the one
     * from `stream/web` (which `Bun.spawn().stdout` is typed as under the
     * extension's tsconfig) does not. Naming either concrete type makes the
     * assignment a compile error under the other, and the previous `as` cast
     * only moved which side failed. Only `read` and `cancel` are ever called,
     * and both types satisfy this — so it is the honest contract.
     */
    let stdoutReader: {
        read(): Promise<{ value?: Uint8Array; done: boolean }>
        cancel(): Promise<unknown>
    } | null = null
    let pumping = false

    // Full recording — every byte captured this session, for the STT blob.
    const chunks: Uint8Array[] = []

    // Rolling window — most recent windowSamples worth of samples (16-bit PCM = 2 bytes/sample), for FFT.
    const windowBytes = opts.windowSamples * 2
    let ring = new Uint8Array(windowBytes)
    let ringFilled = 0

    function pushToRing(chunk: Uint8Array): void {
        if (chunk.length >= windowBytes) {
            ring.set(chunk.subarray(chunk.length - windowBytes))
            ringFilled = windowBytes
            return
        }
        // Shift left, append new bytes at the end.
        ring.copyWithin(0, chunk.length)
        ring.set(chunk, windowBytes - chunk.length)
        ringFilled = Math.min(windowBytes, ringFilled + chunk.length)
    }

    async function pump(): Promise<void> {
        if (!stdoutReader) return
        pumping = true
        try {
            while (pumping) {
                const { value, done } = await stdoutReader.read()
                if (done) break
                if (value) {
                    chunks.push(value)
                    pushToRing(value)
                }
            }
        } catch {
            // Reader errors on kill()/stream close — expected during stop(), not a real failure.
        }
    }

    return {
        async start(): Promise<void> {
            if (proc) throw err("MIC_ALREADY_CAPTURING")

            const backend = detectBackend()
            if (!backend) {
                throw err("MIC_CAPTURE_UNAVAILABLE")
            }

            proc = Bun.spawn(
                [backend, ...buildArgs(backend, opts.sampleRate)],
                // stdin must never inherit the real TTY — VTerm has it in raw
                // mode with mouse tracking enabled, and Bun.spawn defaults
                // stdin to "inherit" when unset. Without this, the capture
                // process ends up sharing the terminal's input stream, and
                // mouse-tracking escape sequences get garbled onto the screen.
                { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
            )

            // `Bun.spawn().stdout` is `number | ReadableStream` — a raw fd when
            // stdout is inherited/piped to a file, a stream under `"pipe"`.
            // We pass `"pipe"` above, so a stream is what must come back;
            // testing for the capability narrows the union AND catches the
            // case where it did not, which the previous falsy check missed
            // (an fd of 3 is truthy and has no getReader).
            const stdout = proc.stdout
            if (typeof stdout !== "object" || stdout === null || !("getReader" in stdout)) {
                proc.kill()
                proc = null
                throw err("MIC_CAPTURE_FAILED", { detail: `${backend} produced no stdout stream`, context: { backend } })
            }

            stdoutReader = stdout.getReader()
            void pump()

            // The backend prints a startup banner then blocks capturing — a
            // fast, cheap exit (e.g. no device available) surfaces as the
            // process exiting before this resolves. Give it a moment to
            // prove it's actually running.
            const exitedEarly = await Promise.race([
                proc.exited.then(() => true),
                new Promise<false>(resolve => setTimeout(() => resolve(false), 200)),
            ])
            if (exitedEarly) {
                const code = await proc.exited
                proc = null
                throw err("MIC_CAPTURE_FAILED", { detail: `${backend} exited immediately (code ${code}) — is a microphone available?`, context: { backend, exitCode: code } })
            }
        },

        /** Latest window of samples as Float32 in [-1, 1], most recent last. Empty if not enough audio captured yet. */
        currentWindow(): Float32Array {
            const out = new Float32Array(opts.windowSamples)
            if (ringFilled < windowBytes) return out // not full yet — caller treats as silence

            const view = new DataView(ring.buffer, ring.byteOffset, ring.byteLength)
            for (let i = 0; i < opts.windowSamples; i++) {
                out[i] = view.getInt16(i * 2, true) / 32768
            }
            return out
        },

        isCapturing(): boolean {
            return proc !== null
        },

        /** Stops capture and returns the full recording as a playable WAV blob. */
        async stop(): Promise<Blob> {
            pumping = false
            if (proc) {
                proc.kill()
                await proc.exited.catch(() => {})
            }
            await stdoutReader?.cancel().catch(() => {})
            proc = null
            stdoutReader = null

            const pcm = concatChunks(chunks)
            chunks.length = 0
            ring = new Uint8Array(windowBytes)
            ringFilled = 0

            return wrapWav(pcm, opts.sampleRate)
        },
    }
}

export type CaptureT = ReturnType<typeof Capture>

function concatChunks(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
    }
    return out
}

/** Wraps raw 16-bit mono PCM in a standard WAV header — the STT endpoint expects a real audio file, not a bare byte stream. */
function wrapWav(pcm: Uint8Array, sampleRate: number): Blob {
    const header = new ArrayBuffer(44)
    const view = new DataView(header)
    const dataSize = pcm.length

    function writeString(offset: number, str: string) {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
    }

    writeString(0, "RIFF")
    view.setUint32(4, 36 + dataSize, true)
    writeString(8, "WAVE")
    writeString(12, "fmt ")
    view.setUint32(16, 16, true) // fmt chunk size
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, 1, true) // mono
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true) // byte rate (16-bit mono)
    view.setUint16(32, 2, true) // block align
    view.setUint16(34, 16, true) // bits per sample
    writeString(36, "data")
    view.setUint32(40, dataSize, true)

    return new Blob([header, pcm.slice().buffer], { type: "audio/wav" })
}
