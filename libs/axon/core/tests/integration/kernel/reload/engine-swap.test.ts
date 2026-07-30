import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

describe("kernel reload: engine swap", () => {
    it("a request after update() uses the new engine, not the one from boot", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "from the old engine" }) } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "from the new engine" }) } })

        const result = await runtime.axon.request("hello")

        expect(result.text).toBe("from the new engine")

        await runtime.shutdown()
    })

    it("the old engine is never called again after a swap", async () => {
        let oldEngineCalls = 0
        const oldEngine = Mock(() => { oldEngineCalls++; return "old" })

        const runtime = await Axon({ blueprint: { config: { engine: oldEngine } } })
        await runtime.axon.request("first")
        expect(oldEngineCalls).toBe(1)

        await runtime.update({ config: { engine: Mock(() => "new") } })
        await runtime.axon.request("second")

        expect(oldEngineCalls).toBe(1) // unchanged — only the new engine served the second call

        await runtime.shutdown()
    })

    it("swapping to an engine with no config still lets the kernel run — update() doesn't corrupt other config", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "v1" }) } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "v2" }) } })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("v2")

        await runtime.shutdown()
    })

    it("session history survives an engine swap — the new engine sees prior conversation", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ remember: "noted" }) } },
        })

        await runtime.axon.request("remember this fact")

        await runtime.update({ config: { engine: Mock(() => "post-swap reply") } })
        await runtime.axon.request("what now")

        const userTurns = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")

        expect(userTurns.length).toBe(2)

        await runtime.shutdown()
    })

    it("update() with an empty config partial (merge mode) leaves the current engine in place", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "still here" }) } },
        })

        // Default mode is "merge" — a partial programmatic update changes only
        // what it names; the engine set at boot survives an empty config.
        await runtime.update({ config: {} })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("still here")

        await runtime.shutdown()
    })

    it("update() in replace mode drops a config field the reloaded blueprint omits", async () => {
        // A file reload passes mode:"replace" — the config file is authoritative,
        // so a field the author deleted (commenting out `policy`) disappears
        // rather than lingering (which kept a confined sandbox locked until a
        // full restart). Merge mode would retain it; replace mirrors the file.
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "v" }), policy: { isolation: "none", fs: { read: ["/tmp/x"] } } } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "v" }) } }, { mode: "replace" })

        expect(runtime.blueprint.config.policy?.fs).toBeUndefined()

        await runtime.shutdown()
    })
})
