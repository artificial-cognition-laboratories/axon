import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

describe("axon.stream", () => {
    it("returns an object with a stream field, not a bare generator", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const result = runtime.axon.stream("hello")

        expect(result).toHaveProperty("stream")
        expect(result).toHaveProperty("interrupt")
        expect(typeof result.stream[Symbol.asyncIterator]).toBe("function")
        expect(typeof result.interrupt).toBe("function")

        for await (const _ of result.stream) { /* drain */ }
        await runtime.shutdown()
    })

    it("yields entries as they're produced, ending with the agent's text", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const { stream } = runtime.axon.stream("hello")
        const entries = []
        for await (const entry of stream) entries.push(entry)

        expect(entries.some(e => e.type === "cognet:output:text")).toBe(true)

        await runtime.shutdown()
    })

    it("accepts an ordered prompt batch as one stream", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        const { stream } = runtime.axon.stream({ prompt: ["hello", "and this too"] })
        for await (const _ of stream) { /* drain */ }

        expect(runtime.session.entries
            .filter(entry => entry.type === "cognet:stimulus:text")
            .map(entry => (entry.data as { content: string }).content))
            .toEqual(["hello", "and this too"])

        await runtime.shutdown()
    })

    it("a second stream() call while the first is still open throws RUN_IN_PROGRESS", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        const first = runtime.axon.stream("hello")

        expect(() => runtime.axon.stream("hello again")).toThrow(expect.objectContaining({ code: "AX-KERNEL-002" }))

        for await (const _ of first.stream) { /* drain to release the lock */ }
        await runtime.shutdown()
    })

    it("rejects (throws on iteration) when the engine fails", async () => {
        const runtime = await Axon()

        const { stream } = runtime.axon.stream("hello")

        await expect((async () => {
            for await (const _ of stream) { /* noop */ }
        })()).rejects.toThrow(/No Engine Configured/)

        await runtime.shutdown()
    })
})
