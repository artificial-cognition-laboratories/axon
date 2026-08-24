import { Axon, driver } from "../../../setup/axon"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"

/** An engine whose driver throws immediately instead of streaming anything. */
function throwingEngine(message: string) {
    const def: AxonEngineDef = {
        name: "throwing",
        // eslint-disable-next-line require-yield
        create: () => ({
            async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                throw new Error(message)
            },
        }),
    }
    return def
}

describe("kernel failure: engine errors", () => {
    it("a throwing engine driver rejects the request rather than hanging or silently swallowing", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [driver(throwingEngine("provider exploded"))] } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow(/provider exploded/)

        await runtime.shutdown()
    })

    it("does not commit a fake cognet:output:text when the engine fails", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [driver(throwingEngine("boom"))] } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow()

        expect(runtime.session.entries.some(e => e.type === "cognet:output:text")).toBe(false)

        await runtime.shutdown()
    })

    it("still commits the user's message before the engine fails", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [driver(throwingEngine("boom"))] } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow()

        expect(runtime.session.entries.some(e => e.type === "cognet:stimulus:text")).toBe(true)

        await runtime.shutdown()
    })

    it("the lock releases after an engine failure — a fresh run is accepted afterward", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [driver(throwingEngine("boom"))] } } })

        await expect(runtime.kernel.request({ content: "hello" })).rejects.toThrow()

        await expect(runtime.kernel.request({ content: "again" })).rejects.toThrow(/boom/)

        await runtime.shutdown()
    })

    it("an agent with no inference refuses to boot, rather than failing at the first call", async () => {
        // A cognet declaring an engine role that nothing can fill is a
        // misconfiguration the runtime can see BEFORE the brain loads — so it
        // fails there, naming the unfilled role, instead of booting an agent
        // that will reach for a model mid-wake and die holding a conversation.
        await expect(Axon({ blueprint: { config: { providers: [] } } }))
            .rejects.toMatchObject({ code: "AX-ENGINE-003" })
    })
})
