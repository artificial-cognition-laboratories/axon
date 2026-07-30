import { Axon } from "../../../setup/axon"

describe("server reload: update", () => {
    it("mounts new routes after update()", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "GET", path: "/old", handler: () => ({ from: "old" }) },
                ] },
            },
        })

        await runtime.update({
            server: { routes: [
                { method: "GET", path: "/new", handler: () => ({ from: "new" }) },
            ] },
        })

        const res = await runtime.server.handler(new Request("http://local/new"))
        expect(await res.json()).toEqual({ from: "new" })

        await runtime.shutdown()
    })

    it("drops routes that update() didn't re-declare", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "GET", path: "/old", handler: () => ({ from: "old" }) },
                ] },
            },
        })

        await runtime.update({
            server: { routes: [
                { method: "GET", path: "/new", handler: () => ({ from: "new" }) },
            ] },
        })

        const res = await runtime.server.handler(new Request("http://local/old"))
        expect(res.status).toBe(404)

        await runtime.shutdown()
    })

    it("swaps middleware on update()", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [{ name: "old", handler: () => { calls.push("old") } }],
                    routes: [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }],
                },
            },
        })

        await runtime.update({
            server: {
                middleware: [{ name: "new", handler: () => { calls.push("new") } }],
                routes: [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }],
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["new"])

        await runtime.shutdown()
    })

    it("does not double-register a plugin's lifecycle hooks across repeated reloads", async () => {
        let calls = 0

        const runtime = await Axon({
            blueprint: {
                server: {
                    plugins: [
                        { name: "watch", fn: () => {
                            globalThis.axon.hooks.hook("request:before", () => { calls++ })
                        } },
                    ],
                    routes: [{ method: "GET", path: "/ping", handler: () => ({ ok: true }) }],
                },
            },
        })

        const reload = () => runtime.update({
            server: {
                plugins: runtime.blueprint.server.plugins,
                routes: runtime.blueprint.server.routes,
            },
        })

        await reload()
        await reload()

        calls = 0
        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toBe(1)

        await runtime.shutdown()
    })

    it("keeps the runtime's agent identity stable across update()", async () => {
        const runtime = await Axon({
            blueprint: {
                agent: { name: "stable-agent", version: "1.0.0", hash: "abc" },
                config: {},
            },
        })

        await runtime.update({ server: { routes: [] } })

        expect(runtime.blueprint.agent.name).toBe("stable-agent")

        await runtime.shutdown()
    })
})
