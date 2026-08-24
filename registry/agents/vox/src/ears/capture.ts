/**
 * capture — the microphone, as a stream of fixed-size PCM frames.
 *
 * Deliberately knows nothing about Axon. It spawns whichever capture tool is
 * already on the machine and yields frames; what happens to them is the
 * plugin's business. That keeps this swappable for a ROS bridge, a WebSocket
 * feed, or a file replay without any of them learning about each other.
 *
 * Adapted from the TUI's own mic service (platform/services/mic/capture.ts),
 * which owns a different problem — a rolling FFT window and a full-session
 * recording for batch STT. The detection and spawn args are the reusable
 * part; the accumulation is not, and a continuous stream must never grow an
 * unbounded buffer.
 *
 * NEVER INSTALLS ANYTHING. If no backend exists it fails loudly with a list.
 * Shelling a package manager from inside a running agent is a bad trust story
 * and, in a TUI, fights the terminal for control of the screen.
 */

type CaptureBackend = "arecord" | "sox" | "ffmpeg"

export type CaptureOpts = {
    /** Samples per second. 16k is what speech models want and what mics give cheaply. */
    sampleRate: number
    /**
     * Samples per emitted frame. 512 at 16kHz is 32ms — Silero VAD's native
     * window, so a brain can hand a frame straight to the model with no
     * re-chunking. The body picks this because it is the thing slicing the
     * stream; picking anything else just moves the buffering into the mind.
     */
    frameSamples: number
}

/** First backend found on $PATH wins. Windows has no always-present CLI capture tool. */
function detectBackend(): CaptureBackend | null {
    const candidates: CaptureBackend[] =
        process.platform === "darwin" ? ["sox", "ffmpeg"]
        : process.platform === "win32" ? ["sox", "ffmpeg"]
        : ["arecord", "sox", "ffmpeg"]

    for (const cmd of candidates) {
        if (Bun.which(cmd)) return cmd
    }
    return null
}

/** Spawn args per backend — all produce raw signed 16-bit LE PCM, mono, on stdout. */
function buildArgs(backend: CaptureBackend, sampleRate: number): string[] {
    const rate = String(sampleRate)

    if (backend === "arecord") {
        return ["-t", "raw", "-f", "S16_LE", "-r", rate, "-c", "1", "-"]
    }

    if (backend === "sox") {
        if (process.platform === "darwin" || process.platform === "win32") {
            return ["-d", "-r", rate, "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-"]
        }
        return ["-t", "alsa", "default", "-r", rate, "-c", "1", "-e", "signed-integer", "-b", "16", "-t", "raw", "-"]
    }

    if (process.platform === "darwin") {
        return ["-f", "avfoundation", "-i", ":0", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
    }
    if (process.platform === "win32") {
        return ["-f", "dshow", "-i", "audio=default", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
    }
    return ["-f", "alsa", "-i", "default", "-ac", "1", "-ar", rate, "-f", "s16le", "-"]
}

export type CaptureT = {
    /** The backend actually in use — worth logging once at boot. */
    readonly backend: CaptureBackend
    /** Frames of exactly `frameSamples * 2` bytes, in order, until stopped. */
    frames(): AsyncGenerator<Uint8Array>
    stop(): void
}

export function Capture(opts: CaptureOpts): CaptureT {
    const backend = detectBackend()
    if (!backend) {
        throw new Error(
            "no audio capture tool found — install one of: arecord (alsa-utils), sox, ffmpeg",
        )
    }

    const frameBytes = opts.frameSamples * 2 // 16-bit samples
    let proc: ReturnType<typeof Bun.spawn> | null = null
    let stopped = false

    async function* frames(): AsyncGenerator<Uint8Array> {
        proc = Bun.spawn([backend!, ...buildArgs(backend!, opts.sampleRate)], {
            stdout: "pipe",
            stderr: "pipe",
        })

        // The capture tool emits whatever chunk size it likes; downstream
        // wants exact frames. One carry buffer turns an arbitrary byte
        // stream into a fixed cadence.
        let carry = new Uint8Array(0)

        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
            if (stopped) return

            const merged = new Uint8Array(carry.length + chunk.length)
            merged.set(carry, 0)
            merged.set(chunk, carry.length)

            let offset = 0
            while (merged.length - offset >= frameBytes) {
                yield merged.slice(offset, offset + frameBytes)
                offset += frameBytes
            }
            carry = merged.slice(offset)
        }
    }

    return {
        backend,
        frames,
        stop() {
            stopped = true
            proc?.kill()
            proc = null
        },
    }
}
