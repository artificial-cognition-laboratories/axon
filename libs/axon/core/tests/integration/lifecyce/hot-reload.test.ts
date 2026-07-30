import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

describe("Axon hot-reload", () => {
    it("update() applies a new blueprint that a subsequent request observes", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "before reload" }) } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "after reload" }) } })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("after reload")

        await runtime.shutdown()
    })

    it("commits axon:reload:start and axon:reload:complete to the session log in order", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "v1" }) } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "v2" }) } })

        const types = runtime.session.log.map(e => e.type)
        const start = types.indexOf("axon:reload:start")
        const complete = types.indexOf("axon:reload:complete")

        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)

        await runtime.shutdown()
    })

    it("commits a hot-reload axon:system:message entry to the session's entry log", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "v1" }) } },
        })

        await runtime.update({ config: { engine: Mock({ hello: "v2" }) } })

        const reloadEntry = runtime.session.entries.find(
            e => e.type === "axon:system:message" && (e.data as { type: string }).type === "hot-reload",
        )

        expect(reloadEntry).toBeDefined()

        await runtime.shutdown()
    })

    it("rebuilds the server on every update() — the handle reflects the new blueprint", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "v1" }) } },
        })

        const serverBefore = runtime.server
        await runtime.update({ config: { engine: Mock({ hello: "v2" }) } })
        const serverAfter = runtime.server

        expect(serverAfter).not.toBe(serverBefore)

        await runtime.shutdown()
    })

    it("session history from before the reload is still present afterward", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi" }) } },
        })

        await runtime.axon.request("hello")
        await runtime.update({ config: { engine: Mock({ hello: "hi again" }) } })

        const userTurns = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")
        expect(userTurns.length).toBe(1)

        await runtime.shutdown()
    })
})
