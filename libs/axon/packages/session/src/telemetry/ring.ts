import { home } from "../home"
import { Decoder } from "./decoder"
import { Encoder } from "./encoder"
import type { Envelope } from "./format"

/**
 * How much telemetry one session keeps.
 *
 * 1GB — the sensory ring's bound, for the same reason: a debug window that
 * starts making decisions for you is in the wrong place. Terry at 20Hz writes
 * about 1.9MB a second of it in binary (measured 2026-10-02), so this is about
 * nine minutes.
 *
 * TEMP (2026-10-01): a raw const beside SENSORY_MAX_BYTES until both earn a
 * place in axon.config.ts.
 */
export const TELEMETRY_MAX_BYTES = 1024 * 1024 * 1024

/** Bytes per segment — the eviction granularity, as in the sensory ring. */
const SEGMENT_BYTES = 8 * 1024 * 1024
/** Pending bytes that trigger a write now rather than at the end of this turn. */
const FLUSH_BYTES = 1024 * 1024

export type TelemetryRingOpts = {
    root: string
    sessionId: string
    /** Total bytes retained; 0 disables the ring — it records nothing and costs nothing. */
    maxBytes?: number
    /** A write that failed. Reported, never swallowed: the window will have a gap, and someone should know why. */
    failed(cause: unknown): void
}

/**
 * TelemetryRing — the bounded binary window of the mind's high-rate narration.
 *
 * `record` ENCODES at once, into the current segment's buffer, and writes at
 * the end of the turn: a thousand events a second become a handful of
 * appends. The caller never waits on it — a tick must not wait on the
 * debugger's window — and the order of records is the order of `record`.
 *
 * A segment is self-contained (format.ts): it begins with a header and
 * carries its own string table, so the oldest can be unlinked and every
 * remaining one still reads. A resumed session continues AFTER the segments
 * it finds; appending into one would reference strings defined by an
 * encoder that no longer exists.
 */
export function TelemetryRing(opts: TelemetryRingOpts) {
    const maxBytes = opts.maxBytes ?? TELEMETRY_MAX_BYTES
    const encoder = Encoder()
    /** Segments on disk, oldest first, with what each holds. Read at the first record. */
    let segments: Array<{ file: string; bytes: number }> | null = null
    let index = -1
    let total = 0
    let scheduled = false
    /** Writes, in order. Each reports its own failure; the chain carries on. */
    let tail: Promise<void> = Promise.resolve()

    function open(): Array<{ file: string; bytes: number }> {
        if (segments) return segments
        const found = home.data.telemetry.existing(opts.root, opts.sessionId)
        segments = found.map(segment => ({ file: segment.file, bytes: segment.bytes }))
        total = found.reduce((sum, segment) => sum + segment.bytes, 0)
        index = found.length > 0 ? found[found.length - 1]!.index : -1
        roll()
        return segments
    }

    /** Begin the next segment. What the encoder held for the previous one must already be taken. */
    function roll(): void {
        index += 1
        encoder.begin()
        segments!.push({ file: home.data.telemetry.segment(opts.root, opts.sessionId, index), bytes: 0 })
    }

    /** Queue what is encoded for the newest segment. */
    function flush(): void {
        scheduled = false
        if (encoder.pending === 0) return
        const bytes = encoder.take()
        const segment = segments![segments!.length - 1]!
        segment.bytes += bytes.length
        total += bytes.length
        tail = tail.then(async () => {
            await home.data.telemetry.append(segment.file, bytes)
            // Only segments OLDER than this write's: anything newer still has
            // appends queued behind this one, and unlinking it would let them
            // recreate the file. The newest is never evicted at all — it
            // holds what just happened.
            while (total > maxBytes && segments!.length > 1 && segments![0] !== segment) {
                const oldest = segments!.shift()!
                total -= oldest.bytes
                await home.data.telemetry.evict(oldest.file)
            }
        }).catch(opts.failed)
    }

    return {
        /** Keep one event. Synchronous: it is encoded now and written at the end of this turn. */
        record(event: Envelope): void {
            if (maxBytes === 0) return
            const held = open()
            const current = held[held.length - 1]!
            if (current.bytes + encoder.pending > SEGMENT_BYTES) {
                flush()
                const finished = current.file
                tail = tail.then(() => home.data.telemetry.close(finished)).catch(opts.failed)
                roll()
            }
            encoder.encode(event)
            if (encoder.pending > FLUSH_BYTES) flush()
            else if (!scheduled) {
                scheduled = true
                setImmediate(flush)
            }
        },

        /**
         * The highest seq on disk, or -1 — what a resumed session must
         * continue past. Every event the ring holds consumed a seq the log
         * never saw, so restoring from the log alone would hand them out again.
         */
        async last(): Promise<number> {
            const found = home.data.telemetry.existing(opts.root, opts.sessionId)
            for (let at = found.length - 1; at >= 0; at--) {
                const { events } = Decoder({ numbers: "typed" }).decode(await home.data.telemetry.read(found[at]!.file))
                if (events.length > 0) return events[events.length - 1]!.time.seq
            }
            return -1
        },

        /** Bytes retained, written or waiting — for tests and telemetry, never a gate. */
        get bytes(): number {
            return total + encoder.pending
        },

        /** Write what is waiting and settle every write. Called when the session closes. */
        async drain(): Promise<void> {
            if (segments) flush()
            await tail
            if (segments && segments.length > 0) await home.data.telemetry.close(segments[segments.length - 1]!.file)
        },
    }
}

export type TelemetryRingT = ReturnType<typeof TelemetryRing>
