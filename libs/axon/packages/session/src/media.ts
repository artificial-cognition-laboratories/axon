import { pathToFileURL } from "node:url"
import type { StimulusRef } from "@arcforge/types"
import { home } from "./home"

/**
 * Media — the bytes sensory events refer to, kept beside the session.
 *
 * A camera frame is too heavy to ride an event. Inlined as base64 it was
 * copied, parsed and re-encoded at every hop — the link to the supervisor,
 * the bus, every attached stream, the ring — twenty-four times a second,
 * and almost none of those hops ever looked at it. So a producer keeps the
 * bytes here ONCE and its event carries the reference this returns; the
 * mind and the debugger read the file when, and only when, they look.
 *
 * Bounded by bytes for the same reason the sensory ring is: it is a window
 * on recent sensation, not a record. A reference can therefore outlive its
 * bytes, and a reader that finds the file gone is looking at something that
 * aged out — which it must say, not paper over.
 */

/** How much media one session keeps. About seven minutes of one 24Hz camera. */
export const MEDIA_MAX_BYTES = 1024 * 1024 * 1024

/** The file extension each kind of media is kept under. A kind not listed here cannot be kept. */
const EXTENSIONS: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/wav": "wav",
    // A reading too large to inline — a depth grid, a point cloud — kept as its raw bytes.
    "application/octet-stream": "bin",
    // A depth camera's grid, as the body contract carries one: metres as 32-bit little-endian floats, row-major.
    "application/vnd.axon.depth+f32le": "f32",
}

type MediaOpts = {
    root: string
    sessionId: string
    /** Total bytes retained before the oldest are dropped. */
    maxBytes?: number
}

export function Media(opts: MediaOpts) {
    const maxBytes = opts.maxBytes ?? MEDIA_MAX_BYTES

    /** What is on disk, oldest first. Null until the first keep has looked at what an earlier run left. */
    let kept: Array<{ file: string; bytes: number }> | null = null
    let next = 0
    let total = 0

    /** Keeps are serialized: two at once would number the same file and evict against a stale total. */
    let tail: Promise<unknown> = Promise.resolve()

    function held(): Array<{ file: string; bytes: number }> {
        if (kept) return kept
        const existing = home.data.media.existing(opts.root, opts.sessionId)
        kept = existing.map(item => ({ file: item.file, bytes: item.bytes }))
        total = existing.reduce((sum, item) => sum + item.bytes, 0)
        next = existing.length > 0 ? existing[existing.length - 1]!.index + 1 : 0
        return kept
    }

    return {
        /**
         * Keep `bytes` and return the reference an event carries in their
         * place. Resolves once the file is whole on disk — a reference is
         * never handed out for bytes a reader could not yet open.
         */
        keep(bytes: Uint8Array, mime: string): Promise<StimulusRef> {
            const extension = EXTENSIONS[mime]
            if (!extension) throw new Error(`media of kind ${mime} cannot be kept — it has no file extension in the media table`)

            const done = tail.then(async () => {
                const list = held()
                const file = home.data.media.file(opts.root, opts.sessionId, next++, extension)
                await home.data.media.write(file, bytes)
                list.push({ file: file, bytes: bytes.byteLength })
                total += bytes.byteLength
                // The newest is never dropped, even alone over the bound: it is the one just referred to.
                while (total > maxBytes && list.length > 1) {
                    const oldest = list.shift()!
                    total -= oldest.bytes
                    await home.data.media.evict(oldest.file)
                }
                return { uri: pathToFileURL(file).href, mime: mime, bytes: bytes.byteLength }
            })
            // A failed keep rejects for its caller; it must not fail every keep after it.
            tail = done.catch(() => {})
            return done
        },

        /** Bytes currently kept — for tests and telemetry, never a gate. */
        get bytes(): number {
            return total
        },

        /** Settle in-flight keeps. */
        async drain(): Promise<void> {
            await tail
        },
    }
}

export type MediaT = ReturnType<typeof Media>
