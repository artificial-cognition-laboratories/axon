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

    it("refuses to boot when nothing can supply the cognet's engines", async () => {
        // An agent with no inference is caught at boot now, not at the first
        // request: the cognet declares what it needs, so the mismatch is
        // visible before a conversation has started.
        await expect(Axon({ blueprint: { config: { providers: [] } } }))
            .rejects.toMatchObject({ code: "AX-ENGINE-003" })
    })
})
