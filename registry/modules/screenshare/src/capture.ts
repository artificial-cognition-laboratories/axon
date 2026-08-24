import type { Output } from "./outputs"

/**
 * capture — one screen region, as a stream of JPEG frames.
 *
 * The same shape as a camera, because it is the same problem: a source of
 * frames the body re-encodes for transport and judges not at all. What is on
 * the screen is the mind's business.
 *
 * X11 only, deliberately. Wayland has no equivalent to x11grab — it requires
 * the desktop portal plus PipeWire and a user permission prompt, which is a
 * genuinely different pipeline rather than a different flag. Writing it blind
 * for a case that cannot be tested here is how untested code rots in; this
 * fails loudly instead, and the portal path lands when someone can exercise
 * it.
 */

export type ScreenCaptureOpts = {
    /** Region to grab, already resolved from a name — see outputs.ts. */
    region: Output
    /** X display, e.g. ":0". */
    display: string
    fps: number
    /**
     * Long-edge width of the emitted frames. Height follows the region's
     * own aspect, so a rotated monitor stays rotated rather than being
     * squashed into someone's idea of landscape.
     */
    width: number
    /** JPEG quality on ffmpeg's scale: 2 is best, 31 is worst. */
    quality: number
}

const SOI = 0xffd8
const EOI = 0xffd9

function buildArgs(opts: ScreenCaptureOpts): string[] {
    const { region, display, fps, width, quality } = opts

    // Aspect preserved from the SOURCE, and forced even so a rotated screen
    // (1440x2560) does not get an odd height ffmpeg's encoder rejects.
    const height = Math.round((width * region.height) / region.width / 2) * 2

    return [
        "-f", "x11grab",
        "-framerate", String(fps),
        "-video_size", `${region.width}x${region.height}`,
        // The region's position in the root window — this is the whole
        // reason geometry is resolved rather than configured.
        "-i", `${display}+${region.x},${region.y}`,
        "-vf", `scale=${width}:${height}`,
        "-q:v", String(quality),
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
}

export type ScreenCaptureT = {
    frames(): AsyncGenerator<Uint8Array>
    stop(): void
}

export function ScreenCapture(opts: ScreenCaptureOpts): ScreenCaptureT {
    if (!Bun.which("ffmpeg")) {
        throw new Error("no screen capture tool found — install ffmpeg")
    }

    let stopped = false

    // Spawned at CONSTRUCTION so stop() is total: a lazy spawn makes it a
    // no-op for a capture that has not started iterating, which on a hot
    // reload leaves the old process running.
    const proc = Bun.spawn(["ffmpeg", ...buildArgs(opts)], { stdout: "pipe", stderr: "pipe" })

    /**
     * Drained from construction, or ffmpeg deadlocks: it writes its banner
     * immediately, and with nothing reading, the pipe buffer fills and the
     * process blocks BEFORE producing a frame. Reads as a capture that is
     * alive and silent.
     */
    const diagnostics: string[] = []
    void (async () => {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            for (const line of new TextDecoder().decode(chunk).split("\n")) {
                const text = line.trim()
                if (!/error|denied|busy|no such|not found|failed|invalid|cannot open/i.test(text)) continue
                diagnostics.push(text)
                if (diagnostics.length > 3) diagnostics.shift()
            }
        }
    })().catch(() => {})

    async function* frames(): AsyncGenerator<Uint8Array> {
        // mjpeg over a pipe is one continuous byte stream, not framed
        // records — frames are recovered by scanning for the format's own
        // markers, which needs no agreement with the producer.
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

        if (!stopped && produced === 0) {
            const reason = [...new Set(diagnostics.map(line => line.replace(/^\[.*?\]\s*/, "")))].join("; ")
            throw new Error(`screen produced no frames — ${reason || "no output from ffmpeg"}`)
        }
    }

    return {
        frames,
        stop() {
            stopped = true
            // SIGKILL: ffmpeg blocked mid-grab ignores SIGTERM long enough
            // for a reload to spawn its replacement while this one still
            // holds the display.
            proc.kill("SIGKILL")
        },
    }
}
