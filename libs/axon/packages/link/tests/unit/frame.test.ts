import { FrameReader, encodeFrame, encodeMessage, decodeMessage, MAX_FRAME_BYTES } from "../../src/frame"
import { describe, it, expect } from "bun:test"

/**
 * Framing is where stream-socket bugs live. A SOCK_STREAM coalesces and splits
 * writes freely — one write can arrive as three reads, three writes as one —
 * and every one of those cases is exercisable here with no socket at all,
 * which is exactly why the codec is pure.
 */
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe("FrameReader — the cases a stream socket actually produces", () => {
    it("reads one whole frame from one chunk", () => {
        const reader = FrameReader()
        const frames = reader.push(encodeFrame(bytes("hello")))
        expect(frames.map(text)).toEqual(["hello"])
        expect(reader.pending).toBe(0)
    })

    it("reassembles a frame split across chunks", () => {
        const reader = FrameReader()
        const frame = encodeFrame(bytes("hello world"))

        expect(reader.push(frame.slice(0, 3))).toEqual([])   // partial HEADER
        expect(reader.push(frame.slice(3, 7))).toEqual([])   // rest of header + partial body
        expect(reader.push(frame.slice(7)).map(text)).toEqual(["hello world"])
        expect(reader.pending).toBe(0)
    })

    it("yields several frames when writes coalesce into one read", () => {
        const reader = FrameReader()
        const merged = new Uint8Array([
            ...encodeFrame(bytes("one")),
            ...encodeFrame(bytes("two")),
            ...encodeFrame(bytes("three")),
        ])
        expect(reader.push(merged).map(text)).toEqual(["one", "two", "three"])
    })

    it("handles a frame spanning three chunks with a fourth frame trailing", () => {
        const reader = FrameReader()
        const big = encodeFrame(bytes("x".repeat(300)))
        const small = encodeFrame(bytes("tail"))

        expect(reader.push(big.slice(0, 100))).toEqual([])
        expect(reader.push(big.slice(100, 200))).toEqual([])
        const out = reader.push(new Uint8Array([...big.slice(200), ...small]))
        expect(out.map(text)).toEqual(["x".repeat(300), "tail"])
    })

    it("reads a zero-length frame as an empty payload, not as end-of-stream", () => {
        const reader = FrameReader()
        expect(reader.push(encodeFrame(new Uint8Array(0))).map(text)).toEqual([""])
    })

    it("preserves payload bytes that contain newlines", () => {
        // The property line-delimited framing cannot offer: the payload is
        // opaque, so a newline in the data is just a byte.
        const reader = FrameReader()
        const payload = "line one\nline two\n"
        expect(reader.push(encodeFrame(bytes(payload))).map(text)).toEqual([payload])
    })

    it("does not alias the caller's chunk", () => {
        // A socket may reuse its read buffer for the next chunk. Holding a
        // reference to it would let those bytes be rewritten underneath us.
        const reader = FrameReader()
        const frame = encodeFrame(bytes("stable"))
        const scratch = new Uint8Array(frame)

        reader.push(scratch.slice(0, 5))
        scratch.fill(0)                       // the socket reuses its buffer
        expect(reader.push(frame.slice(5)).map(text)).toEqual(["stable"])
    })

    it("reports bytes still buffered mid-frame", () => {
        const reader = FrameReader()
        reader.push(encodeFrame(bytes("hello")).slice(0, 6))
        expect(reader.pending).toBe(6)
    })
})

describe("FrameReader — refusing a hostile length prefix", () => {
    it("throws rather than allocating what a corrupt prefix asked for", () => {
        // The prefix is attacker-controlled input. Trusting it means
        // allocating an arbitrary buffer on command.
        const reader = FrameReader()
        const header = new Uint8Array(4)
        new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)

        expect(() => reader.push(header)).toThrow(/AX-LINK-004|exceeds/i)
    })

    it("refuses to encode an oversized payload", () => {
        expect(() => encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(/AX-LINK-004|exceeds/i)
    })
})

describe("messages", () => {
    it("round-trips a JSON message", () => {
        const reader = FrameReader()
        const [frame] = reader.push(encodeMessage({ type: "stimulus", id: "a1", data: { text: "hi" } }))
        expect(decodeMessage(frame!) as unknown as Record<string, unknown>).toEqual({ type: "stimulus", id: "a1", data: { text: "hi" } })
    })

    it("throws on a malformed payload instead of skipping it", () => {
        // The peer is our own code speaking a versioned protocol: a frame that
        // does not parse means the stream is desynchronised or the peer is
        // broken. The capsule's JSONL reader `continue`d past this, which
        // turns a desync into an agent that quietly stops responding.
        expect(() => decodeMessage(bytes("{not json"))).toThrow()
    })

    it("carries a payload whose JSON contains newlines and braces", () => {
        const reader = FrameReader()
        const message = { code: "function f() {\n  return 1\n}" }
        const [frame] = reader.push(encodeMessage(message))
        expect(decodeMessage(frame!) as unknown as Record<string, unknown>).toEqual(message)
    })
})
