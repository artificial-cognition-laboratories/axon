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

    it("boots on the implicit pool rather than failing at the first call", async () => {
        // A cognet declaring an engine role that nothing can fill is a
        // misconfiguration the runtime can see BEFORE the brain loads — so it
        // fails there, naming the unfilled role, instead of booting an agent
        // that will reach for a model mid-wake and die holding a conversation.
        // ENGINE_REQUIREMENTS_UNMET is still what that failure is.
        //
        // What changed is the TRIGGER. `providers: []` used to reach it, and
        // does not any more: `axon` and `mock` are implicit (see
        // providerPool), so an empty array is a pool of two rather than a pool
        // of none. A role mock can serve is therefore filled, and the agent
        // boots — which is the better outcome for the case that actually
        // occurs, a user who cleared their providers and wants a usable
        // terminal rather than a crash.
        const runtime = await Axon({ blueprint: { config: { providers: [] } } })

        expect(runtime.kernel.engines?.has("main")).toBe(true)

        await runtime.shutdown()
    })
})
