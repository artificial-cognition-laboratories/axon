import { existsSync } from "node:fs"

export type VideoCaptureOpts = {
    /** Device path (Linux) or index. `/dev/video0` is the first webcam. */
    device: string
    /** Frames per second to pull. The camera's own rate is usually higher. */
    fps: number
    /**
     * Width in pixels — smaller keeps a frame affordable to inline.
     *
     * Height is NOT configured: it is derived from the source's own aspect
     * by ffmpeg's `-2` (nearest even number, which the encoder requires).
     * A camera that only does 4:3 must not be stretched into someone's
     * assumption of 16:9, and only the device knows which it is.
     */
    width: number
    /** JPEG quality, ffmpeg's scale: 2 is best, 31 is worst. */
    quality: number
}

const SOI = 0xffd8
const EOI = 0xffd9

function buildArgs(opts: VideoCaptureOpts): string[] {
    const input = process.platform === "darwin"
        ? ["-f", "avfoundation", "-framerate", String(opts.fps), "-i", opts.device]
        : process.platform === "win32"
        ? ["-f", "dshow", "-i", `video=${opts.device}`]
        : ["-f", "v4l2", "-framerate", String(opts.fps), "-i", opts.device]

    return [
        ...input,
        "-vf", `scale=${opts.width}:-2`,
        "-r", String(opts.fps),
        "-q:v", String(opts.quality),
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
}

export type VideoCaptureT = {
    frames(): AsyncGenerator<Uint8Array>
    stop(): void
}

export function VideoCapture(opts: VideoCaptureOpts): VideoCaptureT {
    if (!Bun.which("ffmpeg")) {
        throw new Error("no video capture tool found — install ffmpeg")
    }
    if (!existsSync(opts.device)) {
        throw new Error(`no camera at ${opts.device}`)
    }

    /**
     * Spawned at CONSTRUCTION, not on the first frames() pull.
     *
     * A lazy spawn makes stop() a no-op for anything that has not started
     * iterating yet — and a hot reload does exactly that: it constructs the
     * new capture, then stops the old one, and if either side's process
     * exists outside the window where stop() can see it, the device stays
     * held. One orphaned ffmpeg per reload, each holding a camera nothing
     * else can open, and the symptom is a plugin that logs nothing at all.
     *
     * Owning the process for the object's whole lifetime makes stop() total.
     */
    let stopped = false
    const proc = Bun.spawn(["ffmpeg", ...buildArgs(opts)], { stdout: "pipe", stderr: "pipe" })

    /**
     * ffmpeg says why it failed on stderr and then exits, which without this
     * reads as a stream that simply never yielded — the camera equivalent of
     * a silent failure. Only lines stating a problem are kept: the banner is
     * thirty lines of build configuration, and pasting it into an error
     * buries the one sentence that matters.
     *
     * DRAINED FROM CONSTRUCTION, not from the first frames() pull. ffmpeg
     * writes its banner the moment it starts; with nothing reading, that
     * fills the stderr pipe buffer and ffmpeg BLOCKS on the write — before
     * it has produced a single frame. The camera light comes on (the device
     * did open), stdout stays empty forever, and the capture looks alive
     * while being deadlocked on a pipe nobody drained. Spawn and drain must
     * begin together.
     */
    const diagnostics: string[] = []
    void (async () => {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            for (const line of new TextDecoder().decode(chunk).split("\n")) {
                const text = line.trim()
                if (!/error|denied|busy|no such|not found|failed|invalid/i.test(text)) continue
                diagnostics.push(text)
                if (diagnostics.length > 3) diagnostics.shift()
            }
        }
    })().catch(() => {})

    async function* frames(): AsyncGenerator<Uint8Array> {

        let carry = new Uint8Array(0)
        let produced = 0

        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
            if (stopped) return
            produced += chunk.length

            const merged = new Uint8Array(carry.length + chunk.length)
            merged.set(carry, 0)
            merged.set(chunk, carry.length)

            let start = 0
            let cursor = 0
            let emitted = 0

            while (cursor < merged.length - 1) {
                const marker = (merged[cursor]! << 8) | merged[cursor + 1]!
                if (marker === SOI) {
                    start = cursor
                    cursor += 2
                    continue
                }
                if (marker === EOI && cursor > start) {
                    yield merged.slice(start, cursor + 2)
                    emitted = cursor + 2
                    cursor += 2
                    start = cursor
                    continue
                }
                cursor++
            }

            carry = merged.slice(emitted)
        }

        // The stream ended. If it never carried a byte, the camera never
        // opened — say what ffmpeg said rather than returning quietly and
        // leaving a lane that is empty for no stated reason.
        if (!stopped && produced === 0) {
            // Deduplicated: ffmpeg states one failure across several lines
            // ("Error opening input", "Error opening input file X", "Error
            // opening input files"), and repeating it three times makes one
            // problem look like three.
            const reason = [...new Set(diagnostics.map(line => line.replace(/^\[.*?\]\s*/, "")))].join("; ")
            throw new Error(`camera produced no frames — ${reason || "no output from ffmpeg"}`)
        }
    }

    return {
        frames,
        stop() {
            stopped = true

            /**
             * SIGTERM first, SIGKILL only if it will not go.
             *
             * A straight SIGKILL releases the device promptly and leaves the
             * camera's streaming state machine mid-frame — repeated often
             * enough (every hot reload), a UVC device wedges: it enumerates,
             * it opens, its light comes on, and it delivers zero packets to
             * anything. Recovering needs a physical replug, which is not a
             * thing a dev loop may require.
             *
             * So: ask ffmpeg to close the stream properly, and escalate only
             * if it is still there. The grace is short because v4l2 access is
             * exclusive and the next capture cannot start until this one
             * lets go.
             */
            proc.kill("SIGTERM")
            const escalate = setTimeout(() => {
                try {
                    proc.kill("SIGKILL")
                } catch {
                    // Already gone — the graceful path worked.
                }
            }, 300)
            void proc.exited.then(() => clearTimeout(escalate))
        },
    }
}
