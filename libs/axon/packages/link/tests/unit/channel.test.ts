import { Channel, type ChannelHandlers } from "../../src/channel"
import { describe, it, expect } from "bun:test"

/**
 * Channel is the correlation layer: calls to replies, opens to streams,
 * aborts to the work they cancel. It replaces the capsule's two Host() halves,
 * whose response path carried a bare `catch {}` — a completed operation whose
 * reply could not be delivered simply vanished, and the caller hung until its
 * own signal fired. Several tests below exist specifically to pin that shut.
 *
 * A LOOPBACK pair: two channels wired to each other's receive(). Real framing,
 * real correlation, no sockets — every behaviour here is transport-independent
 * and this is the level it can be tested at exhaustively.
 */
function pair(a: ChannelHandlers = {}, b: ChannelHandlers = {}) {
    const errors: Error[] = []
    let left: ReturnType<typeof Channel>
    let right: ReturnType<typeof Channel>

    left = Channel({
        socket: { write: d => { right.receive(d); return d.byteLength }, close: () => {} },
        handlers: a,
        onError: e => errors.push(e),
    })
    right = Channel({
        socket: { write: d => { left.receive(d); return d.byteLength }, close: () => {} },
        handlers: b,
        onError: e => errors.push(e),
    })
    return { left, right, errors }
}

describe("Channel — calls", () => {
    it("resolves a call with the peer's value", async () => {
        const { left } = pair({}, { call: async (verb, arg) => `${verb}:${arg}` })
        expect(await left.call<string>("greet", "world")).toBe("greet:world")
    })

    it("rejects a call when the peer's handler throws", async () => {
        const { left } = pair({}, { call: async () => { throw new Error("nope") } })
        await expect(left.call<string>("x", null)).rejects.toThrow("nope")
    })

    it("rejects when the peer has no handler for the verb", async () => {
        // Silence would be worse: the caller would hang forever on a verb the
        // peer never implemented.
        const { left } = pair({}, {})
        await expect(left.call<string>("missing", null)).rejects.toThrow(/AX-LINK-001|missing/i)
    })

    it("keeps concurrent calls correlated to their own replies", async () => {
        const { left } = pair({}, {
            call: async (_v, arg) => {
                await new Promise(r => setTimeout(r, (arg as number) % 7))
                return arg
            },
        })
        const results = await Promise.all([1, 2, 3, 4, 5].map(n => left.call<number>("echo", n)))
        expect(results).toEqual([1, 2, 3, 4, 5])
    })

    it("aborts an in-flight call and signals the peer", async () => {
        let sawAbort = false
        const { left } = pair({}, {
            call: (_v, _a, signal) => new Promise((_res, rej) => {
                signal.addEventListener("abort", () => { sawAbort = true; rej(new Error("aborted")) })
            }),
        })
        const controller = new AbortController()
        const call = left.call<string>("slow", null, controller.signal)
        controller.abort()
        await expect(call).rejects.toThrow()
        await new Promise(r => setTimeout(r, 10))
        expect(sawAbort).toBe(true)
    })
})

describe("Channel — sends (the audit log's verb)", () => {
    it("delivers fire-and-forget messages in order", async () => {
        const seen: string[] = []
        const { left } = pair({}, { send: (verb, arg) => { seen.push(`${verb}:${arg}`) } })
        left.send("commit", "a")
        left.send("commit", "b")
        left.send("commit", "c")
        expect(seen).toEqual(["commit:a", "commit:b", "commit:c"])
    })

    it("returns nothing — it must never block the hot path", () => {
        const { left } = pair({}, { send: () => {} })
        expect(left.send("commit", "x")).toBeUndefined()
    })

    it("reports a throwing send handler rather than swallowing it", () => {
        // No peer to answer, so without onError this becomes an unhandled
        // rejection — or, as in the capsule, nothing at all.
        const { left, errors } = pair({}, { send: () => { throw new Error("handler blew up") } })
        left.send("commit", "x")
        expect(errors.map(e => e.message)).toContain("handler blew up")
    })
})

describe("Channel — streams (the infer path)", () => {
    it("yields every chunk then completes", async () => {
        const { left } = pair({}, {
            async *stream() { yield "a"; yield "b"; yield "c" },
        })
        const seen: string[] = []
        for await (const chunk of left.stream<string>("infer", null)) seen.push(chunk)
        expect(seen).toEqual(["a", "b", "c"])
    })

    it("propagates a mid-stream failure to the consumer", async () => {
        const { left } = pair({}, {
            async *stream() { yield "a"; throw new Error("provider died") },
        })
        const seen: string[] = []
        await expect((async () => {
            for await (const c of left.stream<string>("infer", null)) seen.push(c)
        })()).rejects.toThrow("provider died")
        expect(seen).toEqual(["a"])
    })

    it("stops the producer when the consumer aborts", async () => {
        // The property that keeps a cancelled wake from burning provider
        // tokens: an interrupt must actually reach the thing generating them.
        let produced = 0
        const { left } = pair({}, {
            async *stream(_v, _a, signal) {
                while (!signal.aborted) { produced++; yield produced; await new Promise(r => setTimeout(r, 1)) }
            },
        })
        const controller = new AbortController()
        const seen: number[] = []
        try {
            for await (const chunk of left.stream<number>("infer", null, controller.signal)) {
                seen.push(chunk)
                if (seen.length === 3) controller.abort()
            }
        } catch { /* abort surfaces as a throw */ }
        const atAbort = produced
        await new Promise(r => setTimeout(r, 30))
        expect(produced).toBeLessThanOrEqual(atAbort + 1)
    })

    it("keeps two concurrent streams separate", async () => {
        const { left } = pair({}, {
            async *stream(_v, arg) { for (let i = 0; i < 3; i++) yield `${arg}${i}` },
        })
        const [one, two] = await Promise.all([
            (async () => { const o: string[] = []; for await (const c of left.stream<string>("infer", "a")) o.push(c); return o })(),
            (async () => { const o: string[] = []; for await (const c of left.stream<string>("infer", "b")) o.push(c); return o })(),
        ])
        expect(one).toEqual(["a0", "a1", "a2"])
        expect(two).toEqual(["b0", "b1", "b2"])
    })
})

describe("Channel — a broken wire fails LOUDLY", () => {
    it("rejects every outstanding call when the wire dies", async () => {
        // The capsule's failure mode: a reply that could not be delivered was
        // swallowed by `catch {}` and the caller hung until its signal fired.
        const { left } = pair({}, { call: () => new Promise(() => {}) })
        const call = left.call<string>("never", null)
        left.fail(new Error("peer died"))
        await expect(call).rejects.toThrow("peer died")
    })

    it("ends every open stream when the wire dies", async () => {
        const { left } = pair({}, { async *stream() { yield "a"; await new Promise(() => {}) } })
        const consume = (async () => { for await (const _ of left.stream("infer", null)) { /* drain */ } })()
        await new Promise(r => setTimeout(r, 5))
        left.fail(new Error("peer died"))
        await expect(consume).rejects.toThrow("peer died")
    })

    it("refuses new work once closed", async () => {
        const { left } = pair()
        left.fail(new Error("gone"))
        expect(left.isClosed).toBe(true)
        await expect(left.call<string>("x", null)).rejects.toThrow("gone")
    })

    it("fails the channel on a desynchronised stream rather than skipping", () => {
        // Every subsequent length prefix would be read at the wrong offset, so
        // skipping the bad frame cannot recover — it only hides the break.
        const { left } = pair()
        const bogus = new Uint8Array(4)
        new DataView(bogus.buffer).setUint32(0, 0xffffffff, false)
        left.receive(bogus)
        expect(left.isClosed).toBe(true)
    })

    it("reports an undecodable frame without tearing down the channel", () => {
        // A single malformed payload is not a desync: the framing was correct,
        // so the stream is still aligned and the next frame is readable.
        const { left, right, errors } = pair()
        const junk = new TextEncoder().encode("{not json")
        const frame = new Uint8Array(4 + junk.byteLength)
        new DataView(frame.buffer).setUint32(0, junk.byteLength, false)
        frame.set(junk, 4)
        right.receive(frame)
        expect(errors.length).toBeGreaterThan(0)
        expect(right.isClosed).toBe(false)
        expect(left.isClosed).toBe(false)
    })
})
