/**
 * capture/audio — the microphone, as a stream of fixed-size PCM frames.
 *
 * Deliberately knows nothing about Axon. It spawns whichever capture tool is
 * already on the machine and yields frames; what happens to them is the
 * plugin's business. That keeps this swappable for a ROS bridge, a WebSocket
 * feed, or a file replay without any of them learning about each other.
 *
 * COPIED from the vox agent rather than shared. Vox is heading somewhere
 * else — predictive processing, with a body that will grow opinions about
 * timing and buffering to serve it — and echo's whole value is being the
 * plainest possible sensor rig. A shared module would have to serve both,
 * and the first divergence would put a flag in it for a caller it should
 * never have known about. Two copies of eighty honest lines is cheaper than
 * one module with a personality.
 *
 * NEVER INSTALLS ANYTHING. If no backend exists it fails loudly with a list.
 * Shelling a package manager from inside a running agent is a bad trust story
 * and, in a TUI, fights the terminal for control of the screen.
 */

type CaptureBackend = "arecord" | "sox" | "ffmpeg"

export type CaptureOpts = {
    /**
     * ALSA device to open — "default", "hw:1,0". Resolved by devices.ts
     * before it reaches here: this module opens what it is told to, and
     * never chooses.
     *
     * Only meaningful for arecord. sox and ffmpeg take the system default
     * on every platform they run on here, so a device selector has nowhere
     * to go in their argument lists — a machine using those backends gets
     * whatever its OS routes.
     */
    device?: string
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
function buildArgs(backend: CaptureBackend, sampleRate: number, device?: string): string[] {
    const rate = String(sampleRate)

    if (backend === "arecord") {
        return [
            ...(device ? ["-D", device] : []),
            "-t", "raw", "-f", "S16_LE", "-r", rate, "-c", "1", "-",
        ]
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
    /**
     * Spawned at CONSTRUCTION, for the same reason the camera is: a lazy
     * spawn makes stop() a no-op for a capture that has not started
     * iterating yet, so a hot reload can leave the old recorder holding the
     * device. ALSA tolerates several openers where v4l2 does not, which is
     * the only reason this never showed up as a broken microphone.
     */
    let stopped = false

    const proc = Bun.spawn([backend, ...buildArgs(backend, opts.sampleRate, opts.device)], {
        stdout: "pipe",
        stderr: "pipe",
    })

    /**
     * Drain stderr from construction, or the recorder deadlocks.
     *
     * A piped stream nobody reads fills its buffer and blocks the writer —
     * so a capture tool that chatters on stderr stops producing audio
     * without ever failing. arecord is quiet enough that this has not bitten
     * yet, which is exactly why it must be handled rather than relied upon:
     * the camera hit it immediately, and the two must not differ on
     * something this basic.
     */
    void (async () => {
        for await (const _ of proc.stderr as ReadableStream<Uint8Array>) {
            // Read and discarded. Failure surfaces as an empty frame stream,
            // which the plugin already reports.
        }
    })().catch(() => {})

    async function* frames(): AsyncGenerator<Uint8Array> {

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
            // SIGKILL: a recorder blocked in an ALSA read ignores SIGTERM
            // until the read returns, which is long enough for a hot reload
            // to spawn its replacement while the old one still holds the
            // device.
            proc.kill("SIGKILL")
        },
    }
}
