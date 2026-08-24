import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

describe("Axon hot-reload", () => {
    it("update() applies a new blueprint that a subsequent request observes", async () => {
        // Observed through `boot`, not through the engine. Inference resolves
        // ONCE against the user's providers and a config reload does not
        // re-bind it — so an engine swap is no longer the thing a reload
        // changes, while the agent's own identity still is.
        const runtime = await Axon({
            blueprint: {
                boot: "before reload",
                config: { providers: [Mock({ hello: "ok" })] },
            },
        })

        await runtime.update({ boot: "after reload" })

        expect(runtime.blueprint.boot).toBe("after reload")

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("ok")

        await runtime.shutdown()
    })

    it("commits axon:reload:start and axon:reload:complete to the session log in order", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        await runtime.update({ config: { providers: [Mock({ hello: "v2" })] } })

        const types = runtime.session.log.map(e => e.type)
        const start = types.indexOf("axon:reload:start")
        const complete = types.indexOf("axon:reload:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)

        await runtime.shutdown()
    })

    it("commits a hot-reload axon:system:message entry to the session's entry log", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        await runtime.update({ config: { providers: [Mock({ hello: "v2" })] } })

        const reloadEntry = runtime.session.entries.find(
            e => e.type === "axon:system:message" && (e.data as { type: string }).type === "hot-reload",
        )

        expect(reloadEntry).toBeDefined()

        await runtime.shutdown()
    })

    it("rebuilds the server on every update() — the handle reflects the new blueprint", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "v1" })] } },
        })

        const serverBefore = runtime.server
        await runtime.update({ config: { providers: [Mock({ hello: "v2" })] } })
        const serverAfter = runtime.server

        expect(serverAfter).not.toBe(serverBefore)

        await runtime.shutdown()
    })

    it("session history from before the reload is still present afterward", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock({ hello: "hi" })] } },
        })

        await runtime.axon.request("hello")
        await runtime.update({ config: { providers: [Mock({ hello: "hi again" })] } })

        const userTurns = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")
        expect(userTurns.length).toBe(1)

        await runtime.shutdown()
    })
})
