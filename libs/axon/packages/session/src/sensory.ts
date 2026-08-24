import { home } from "./home"

/**
 * SensoryRing — the bounded window of dense sense data.
 *
 * The third retention tier, between the permanent log and pure delivery.
 * Audio frames and camera frames are the record of what an agent SENSED,
 * and they are simultaneously too voluminous to keep forever and too
 * useful to throw away the instant a wake consumes them: every real
 * question about a multi-modal agent ("did it hear me", "why did barge-in
 * not fire", "is the camera even reaching the brain") is answered by
 * looking at the last minute, and none of them by reading last week.
 *
 * So: keep a fixed number of BYTES of the most recent sensation, and let
 * the rest fall off the back. The bound is bytes rather than time because
 * bytes are what protects the disk — a minute of 16kHz mono PCM and a
 * minute of inlined 1080p frames differ by three orders of magnitude, and
 * only one of them can be allowed to choose the limit.
 *
 * SIZE 0 IS THE OFF SWITCH, not a special case: a ring configured to hold
 * nothing writes nothing and costs nothing, which is exactly the old
 * transient behaviour. A production agent sets 0 and pays what it always
 * paid; a dev machine turns it up and gains a window.
 */

/**
 * How much sensory data one session keeps.
 *
 * 1GB. An agent with real senses runs several dense streams at once — a
 * microphone, a camera, and two screens is an ordinary desktop body, and
 * every one of them inlines base64 into this window. 256MB covered a single
 * sensor comfortably and became a live constraint the moment a second video
 * feed appeared, which is exactly the wrong place for a debug window to
 * start making decisions for you.
 *
 * A gigabyte of disk is unremarkable on any machine that can run a
 * multi-modal agent, and the bound still holds: this is a ring, so the cost
 * is capped rather than growing. A deployment that cares sets it to 0 and
 * pays nothing.
 *
 * TEMP (2026-08-08): a raw const until this earns a place in
 * axon.config.ts. Deliberately not wired to config yet — the right shape
 * for that knob is clearer once something other than a desktop body has
 * used it.
 */
export const SENSORY_MAX_BYTES = 1024 * 1024 * 1024

/**
 * Bytes per segment file.
 *
 * The eviction granularity: the ring can overshoot its bound by at most
 * one segment, and can under-hold by at most one. 8MB against a 1GB bound
 * is well under 1% either way — small enough to ignore, large enough that a
 * 30Hz stream rolls a file every few seconds rather than constantly.
 */
const SEGMENT_BYTES = 8 * 1024 * 1024

type SensoryRingOpts = {
    root: string
    sessionId: string
    /** total bytes retained; 0 disables the ring entirely */
    maxBytes?: number
}

export function SensoryRing(opts: SensoryRingOpts) {
    const maxBytes = opts.maxBytes ?? SENSORY_MAX_BYTES

    /**
     * Segments this ring has written, oldest first, with their sizes.
     *
     * Held in memory rather than re-stat'd per append: the ring appends at
     * sensor rate, and hitting the filesystem for a size on every frame
     * would make observation cost more than capture.
     */
    const segments: { file: string; bytes: number }[] = []
    let index = 0
    let currentBytes = 0
    let total = 0

    /**
     * Appends are serialized through one promise chain, exactly as the
     * session's Writer serializes the log. Two concurrent appends could
     * otherwise interleave a roll — both seeing the old index, both
     * writing to a segment one of them is about to close.
     */
    let tail: Promise<void> = Promise.resolve()

    async function evictWhileOver(): Promise<void> {
        // The newest segment is never evicted even if it alone exceeds the
        // bound: dropping it would delete the sensation that just arrived,
        // which is the one a watcher is most likely looking at.
        while (total > maxBytes && segments.length > 1) {
            const oldest = segments.shift()!
            total -= oldest.bytes
            await home.data.sensory.evict(oldest.file)
        }
    }

    return {
        /**
         * Record one sensory entry. Resolves once it is on disk and the
         * ring is back within its bound.
         *
         * Never throws for capacity reasons — a full ring evicts, it does
         * not refuse. It DOES propagate a real write failure: a disk that
         * cannot be written to is a fact the caller must see, not one to
         * swallow behind "it was only telemetry".
         */
        async record(entry: unknown): Promise<void> {
            if (maxBytes === 0) return

            const line = JSON.stringify(entry)
            const bytes = Buffer.byteLength(line) + 1 // newline

            tail = tail.then(async () => {
                if (currentBytes > 0 && currentBytes + bytes > SEGMENT_BYTES) {
                    index++
                    currentBytes = 0
                }

                await home.data.sensory.append(opts.root, opts.sessionId, index, entry)

                const current = segments[segments.length - 1]
                if (currentBytes === 0 || !current) {
                    segments.push({ file: home.data.sensory.segment(opts.root, opts.sessionId, index), bytes })
                } else {
                    current.bytes += bytes
                }

                currentBytes += bytes
                total += bytes
                await evictWhileOver()
            })

            return tail
        },

        /** Everything still retained, oldest first. The window a reader sees. */
        async read(): Promise<unknown[]> {
            const files = await home.data.sensory.segments(opts.root, opts.sessionId)
            const entries: unknown[] = []
            for (const file of files) entries.push(...(await home.data.sensory.read(file)))
            return entries
        },

        /** Bytes currently retained — for tests and telemetry, never a gate. */
        get bytes(): number {
            return total
        },

        /** Settle in-flight appends. Called on session close so nothing is torn. */
        async drain(): Promise<void> {
            await tail
        },
    }
}

export type SensoryRingT = ReturnType<typeof SensoryRing>
