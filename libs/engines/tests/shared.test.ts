import { Collect, EngineFailure, readNdjson, readSse } from "../src/shared"

describe("engine shared hardening", () => {
    it("parses a final NDJSON record without requiring a trailing newline", async () => {
        const events = await Array.fromAsync(readNdjson(new Response('{"done":true}')))
        expect(events).toEqual([{ done: true }])
    })

    it("surfaces malformed NDJSON as a protocol error", async () => {
        const drain = Array.fromAsync(readNdjson(new Response('{not-json}\n')))
        await expect(drain).rejects.toThrow(/NDJSON protocol error/)
    })

    it("surfaces malformed SSE data as a protocol error", async () => {
        const drain = Array.fromAsync(readSse(new Response('data: {not-json}\n\n')))
        await expect(drain).rejects.toThrow(/SSE protocol error/)
    })

    it("classifies an aborted empty collection as ABORTED, not EMPTY_RESPONSE", () => {
        const controller = new AbortController()
        controller.abort("user")

        try {
            Collect({ provider: "test", model: "test" }).done({ signal: controller.signal })
            throw new Error("expected collection to fail")
        } catch (error) {
            expect(error).toBeInstanceOf(EngineFailure)
            expect((error as EngineFailure).fault.code).toBe("ABORTED")
        }
    })

    it("does not let an empty terminal snapshot erase valid streamed output", () => {
        const collect = Collect({ provider: "codex", model: "test" })
        collect.feed({ type: "text:delta", content: "<typescript>1 + 1</typescript>" })
        collect.feed({ type: "text:final", content: "" })

        const done = collect.done()
        expect(done.type).toBe("done")
        if (done.type === "done") expect(done.response.text).toBe("<typescript>1 + 1</typescript>")
    })
})
