import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

describe("axon.request", () => {
    it("accepts a bare string and returns the agent's text", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const result = await runtime.axon.request("hello")

        expect(result.text).toBe("hi there")

        await runtime.shutdown()
    })

    it("accepts an options object with a prompt field", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const result = await runtime.axon.request({ prompt: "hello" })

        expect(result.text).toBe("hi there")

        await runtime.shutdown()
    })

    it("returns the full entries array alongside the text", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const result = await runtime.axon.request("hello")

        expect(result.entries.some(e => e.type === "cognet:stimulus:text")).toBe(true)
        expect(result.entries.some(e => e.type === "cognet:output:text")).toBe(true)

        await runtime.shutdown()
    })

    it("commits to the one session log — no thread isolation, everything lands on runtime.session", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        await runtime.axon.request("hello")

        expect(runtime.session.entries.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })

    it("rejects when the engine fails, rather than returning a partial or empty result", async () => {
        const runtime = await Axon()

        await expect(runtime.axon.request("hello")).rejects.toThrow(/No Engine Configured/)

        await runtime.shutdown()
    })
})
