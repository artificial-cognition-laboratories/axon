import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"

describe("kernel execution: multi-turn continuation", () => {
    it("calls the engine again after an executable tick, without a second user message", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("return 1"), "final reply"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const userTurns = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")
        const outputTexts = runtime.session.entries.filter(e => e.type === "cognet:output:text")

        // one user message drove two engine calls: the execution tick, then the reply tick
        expect(userTurns.length).toBe(1)
        expect(outputTexts.length).toBe(1)
        expect((outputTexts[0].data as { content: string }).content).toBe("final reply")

        await runtime.shutdown()
    })

    it("commits entries in causal order: typescript, result, then the final text", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("return 1"), "final reply"] })] } },
        })

        await runtime.kernel.request({ content: "/go" })

        const types = runtime.session.entries.map(e => e.type)

        expect(types).toEqual(["cognet:stimulus:text", "cognet:action:typescript", "cognet:action:result", "cognet:output:text", "axon:agent:done"])

        await runtime.shutdown()
    })

    it("chains through multiple execution ticks before the final text reply", async () => {
        const runtime = await Axon({
            blueprint: {
                config: { providers: [Mock({ "/go": [run("return 1"), run("return 2"), "all done"] })] },
            },
        })

        await runtime.kernel.request({ content: "/go" })

        const types = runtime.session.entries.map(e => e.type)

        expect(types).toEqual([
            "cognet:stimulus:text",
            "cognet:action:typescript", "cognet:action:result",
            "cognet:action:typescript", "cognet:action:result",
            "cognet:output:text",
            // The turn boundary the model declared, written down so it reads
            // its own <done/> back on the next call.
            "axon:agent:done",
        ])

        await runtime.shutdown()
    })

    it("the final cognet:output:text is the only reply surfaced through axon.request()", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ "/go": [run("return 1"), "final reply"] })] } },
        })

        const result = await runtime.axon.request("/go")

        expect(result.text).toBe("final reply")

        await runtime.shutdown()
    })
})
