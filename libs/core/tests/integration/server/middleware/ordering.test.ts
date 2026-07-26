import { Axon } from "../../../setup/axon"

describe("server middleware: ordering", () => {
    it("runs middleware before the route handler", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [
                        { name: "mw", handler: () => { calls.push("middleware") } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["middleware", "route"])

        await runtime.shutdown()
    })

    it("runs multiple middleware in declared order", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [
                        { name: "first", handler: () => { calls.push("first") } },
                        { name: "second", handler: () => { calls.push("second") } },
                        { name: "third", handler: () => { calls.push("third") } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => ({ ok: true }) },
                    ],
                },
            },
        })

        await runtime.server.handler(new Request("http://local/ping"))

        expect(calls).toEqual(["first", "second", "third"])

        await runtime.shutdown()
    })

    it("lets middleware set context the route handler observes", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [
                        { name: "tag", handler: (event) => { event.context.tag = "stamped" } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: (event) => ({ tag: event.context.tag }) },
                    ],
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/ping"))

        expect(await res.json()).toEqual({ tag: "stamped" })

        await runtime.shutdown()
    })

    it("lets middleware short-circuit before the route handler runs", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [
                        { name: "block", handler: () => { calls.push("middleware"); return new Response("blocked", { status: 403 }) } },
                    ],
                    routes: [
                        { method: "GET", path: "/ping", handler: () => { calls.push("route"); return { ok: true } } },
                    ],
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/ping"))

        expect(res.status).toBe(403)
        expect(calls).toEqual(["middleware"])

        await runtime.shutdown()
    })

    it("runs middleware even for routes that don't exist", async () => {
        const calls: string[] = []

        const runtime = await Axon({
            blueprint: {
                server: {
                    middleware: [
                        { name: "mw", handler: () => { calls.push("middleware") } },
                    ],
                    routes: [],
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/nowhere"))

        expect(res.status).toBe(404)
        expect(calls).toEqual(["middleware"])

        await runtime.shutdown()
    })
})
