import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

describe("axon.request", () => {
    it("accepts a bare string and returns the agent's text", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi there" })] } },
        })

        const result = await runtime.axon.request("hello")

        expect(result.text).toBe("hi there")

        await runtime.shutdown()
    })

    it("accepts an options object with a prompt field", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi there" })] } },
        })

        const result = await runtime.axon.request({ prompt: "hello" })

        expect(result.text).toBe("hi there")

        await runtime.shutdown()
    })

    it("returns the full entries array alongside the text", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi there" })] } },
        })

        const result = await runtime.axon.request("hello")

        expect(result.entries.some(e => e.type === "cognet:stimulus:text")).toBe(true)
        expect(result.entries.some(e => e.type === "cognet:output:text")).toBe(true)

        await runtime.shutdown()
    })

    it("commits to the one session log — no thread isolation, everything lands on runtime.session", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.axon.request("hello")

        expect(runtime.session.entries.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })

    it("boots with no declared providers — axon and mock are implicit", async () => {
        // An unfillable role is still caught at boot rather than at the first
        // request: the cognet declares what it needs, so the mismatch is
        // visible before a conversation has started.
        //
        // `providers: []` is no longer that case. `axon` and `mock` come with
        // running Axon and are not things a user declares (see providerPool),
        // so an empty array is a pool of two — and a role mock can serve is
        // filled. See the note in kernel/inference/providers.test.ts for the
        // trade this makes.
        const runtime = await Axon({ blueprint: { config: { providers: [] } } })

        expect(runtime.kernel.engines?.has("main")).toBe(true)

        await runtime.shutdown()
    })
})
