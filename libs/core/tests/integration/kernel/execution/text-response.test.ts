import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

describe("kernel execution: text responses", () => {
    it("a plain text reply lands on the session as cognet:output:text", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } },
        })

        await runtime.kernel.request({ content: "hello" })

        const reply = runtime.session.entries.find(e => e.type === "cognet:output:text")

        expect((reply!.data as { content: string }).content).toBe("Hi there!")

        await runtime.shutdown()
    })

    it("stops after one tick when the reply is text-only — no execution entries", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } },
        })

        await runtime.kernel.request({ content: "hello" })

        expect(runtime.session.entries.some(e => e.type === "cognet:action:typescript")).toBe(false)
        expect(runtime.session.entries.some(e => e.type === "cognet:action:result")).toBe(false)

        await runtime.shutdown()
    })

    it("commits the user's message before the agent's reply, in order", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } },
        })

        await runtime.kernel.request({ content: "hello" })

        const types = runtime.session.entries.map(e => e.type)

        expect(types).toEqual(["cognet:stimulus:text", "cognet:output:text"])

        await runtime.shutdown()
    })

    it("axon.request() surfaces the agent's text as the result's text field", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } },
        })

        const result = await runtime.axon.request("hello")

        expect(result.text).toBe("Hi there!")

        await runtime.shutdown()
    })

    it("a fresh call on the same session sees the prior turn as context", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi", bye: "bye" }) } },
        })

        await runtime.kernel.request({ content: "hello" })
        await runtime.kernel.request({ content: "bye" })

        const userTurns = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")

        expect(userTurns.length).toBe(2)

        await runtime.shutdown()
    })
})
