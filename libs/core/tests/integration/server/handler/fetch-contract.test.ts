import { Axon } from "../../../setup/axon"

describe("server handler: fetch contract", () => {
    it("is a plain function accepting a Request and returning a Response", async () => {
        const runtime = await Axon({ blueprint: {} })

        expect(typeof runtime.server.handler).toBe("function")

        const res = await runtime.server.handler(new Request("http://local/nowhere"))
        expect(res).toBeInstanceOf(Response)

        await runtime.shutdown()
    })

    it("returns a fresh handler reference after update()", async () => {
        const runtime = await Axon({ blueprint: {} })

        const before = runtime.server.handler
        await runtime.update({ server: { routes: [] } })
        const after = runtime.server.handler

        expect(after).not.toBe(before)

        await runtime.shutdown()
    })

    it("the pre-update handler still responds after update() (stale reference, not a dead one)", async () => {
        const runtime = await Axon({
            blueprint: { server: { routes: [
                { method: "GET", path: "/ping", handler: () => ({ ok: true }) },
            ] } },
        })

        const stale = runtime.server.handler
        await runtime.update({ server: { routes: [] } })

        const res = await stale(new Request("http://local/ping"))
        expect(res.status).toBe(200)

        await runtime.shutdown()
    })
})
