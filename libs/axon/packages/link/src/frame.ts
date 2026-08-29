import { err } from "@arcforge/err"
/**
 * Frame — length-prefixed message framing over a stream socket.
 *
 * ── Why explicit framing ────────────────────────────────────────────────────
 *
 * The design called for SOCK_SEQPACKET, where the kernel preserves message
 * boundaries and no framing is needed. Neither Bun.listen nor node:net exposes
 * it — both are SOCK_STREAM only — so boundaries are ours to maintain.
 *
 * Length-prefixed binary rather than the JSONL the capsule wire uses. A stream
 * socket coalesces and splits writes freely: one write can arrive as three
 * reads, three writes can arrive as one. Line-scanning handles that only if
 * no payload can ever contain a newline, which is a property of the ENCODER
 * that nothing enforces — and the capsule already carries a JSON replacer
 * mapping `undefined`→`null` because its encoder could otherwise drop a key
 * and fail the peer's type guard. A length prefix has no such coupling: the
 * payload is opaque bytes and the frame is correct by arithmetic.
 *
 * Wire format, per message:
 *
 *     [4 bytes: big-endian uint32 payload length][payload bytes]
 *
 * Big-endian because it is the network order every hexdump reader expects.
 */

/** Frames larger than this are refused. A length prefix is attacker-controlled input. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

const HEADER_BYTES = 4

/** Encode one payload into a length-prefixed frame. */
export function encodeFrame(payload: Uint8Array): Uint8Array {
    if (payload.byteLength > MAX_FRAME_BYTES) {
        throw err("LINK_FRAME_TOO_LARGE", { detail: `${payload.byteLength} exceeds ${MAX_FRAME_BYTES}`, context: { bytes: payload.byteLength, max: MAX_FRAME_BYTES } })
    }
    const frame = new Uint8Array(HEADER_BYTES + payload.byteLength)
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false)
    frame.set(payload, HEADER_BYTES)
    return frame
}

export type FrameReaderT = {
    /**
     * Feed received bytes. Returns every COMPLETE frame they finished, in
     * order — zero when the chunk was a partial header or body, several when
     * writes coalesced.
     */
    push(chunk: Uint8Array): Uint8Array[]
    /** Bytes buffered but not yet a complete frame. For assertions and diagnostics. */
    readonly pending: number
}

/**
 * The receiving half: bytes in, whole frames out.
 *
 * Stateful by necessity — a frame can straddle any number of reads, so the
 * remainder has to live somewhere between them. Pure otherwise: it performs no
 * I/O and knows nothing about sockets, which is what makes the hard cases
 * (split header, split body, several frames in one chunk, a frame spanning
 * three chunks) testable without opening anything.
 */
export function FrameReader(): FrameReaderT {
    // One growing buffer plus a read offset, compacted only when it would
    // otherwise grow unboundedly. Re-slicing on every push would make a
    // stream of small frames quadratic.
    let buffer = new Uint8Array(0)

    function append(chunk: Uint8Array): void {
        if (buffer.byteLength === 0) {
            // Copied, never aliased: the caller owns `chunk` and a socket
            // implementation is free to reuse its read buffer for the next
            // chunk, which would silently rewrite bytes we still need.
            buffer = new Uint8Array(chunk)
            return
        }
        const next = new Uint8Array(buffer.byteLength + chunk.byteLength)
        next.set(buffer, 0)
        next.set(chunk, buffer.byteLength)
        buffer = next
    }

    return {
        push(chunk: Uint8Array): Uint8Array[] {
            append(chunk)
            const frames: Uint8Array[] = []

            for (;;) {
                if (buffer.byteLength < HEADER_BYTES) break
                const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                const length = view.getUint32(0, false)

                if (length > MAX_FRAME_BYTES) {
                    // A corrupt or hostile prefix. Continuing would allocate
                    // whatever it asked for, so the stream is unrecoverable
                    // and saying so loudly is the only safe answer.
                    throw err("LINK_FRAME_TOO_LARGE", { detail: `declared ${length} exceeds ${MAX_FRAME_BYTES}`, context: { declared: length, max: MAX_FRAME_BYTES } })
                }
                if (buffer.byteLength < HEADER_BYTES + length) break

                frames.push(buffer.slice(HEADER_BYTES, HEADER_BYTES + length))
                buffer = buffer.slice(HEADER_BYTES + length)
            }

            return frames
        },

        get pending() {
            return buffer.byteLength
        },
    }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode a JSON message as a frame. */
export function encodeMessage(message: unknown): Uint8Array {
    return encodeFrame(encoder.encode(JSON.stringify(message)))
}

/**
 * Decode one frame's payload as JSON.
 *
 * Throws on malformed JSON rather than returning null: the peer is our own
 * code speaking a versioned protocol, so a frame that does not parse means the
 * stream is desynchronised or the peer is broken. Both are conditions to fail
 * on, never to skip past — the capsule's JSONL reader silently `continue`d on
 * a parse failure, which turns a desync into an agent that quietly stops
 * responding.
 */
export function decodeMessage<T>(payload: Uint8Array): T {
    return JSON.parse(decoder.decode(payload)) as T
}
