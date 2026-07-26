import { Axon } from "../../../setup/axon"
import { readBody } from "h3"

describe("server routing: dispatch", () => {
    it("routes GET requests to the matching handler", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [
                        { method: "GET", path: "/ping", handler: () => ({ pong: true }) },
                    ]
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/ping"))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ pong: true })

        await runtime.shutdown()
    })

    it("routes POST requests to the matching handler", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [
                        { method: "POST", path: "/echo", handler: async (event) => readBody(event) },
                    ]
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/echo", {
            method: "POST",
            body: JSON.stringify({ hello: "world" }),
            headers: { "content-type": "application/json" },
        }))

        expect(await res.json()).toEqual({ hello: "world" })

        await runtime.shutdown()
    })

    it("resolves path params", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [
                        { method: "GET", path: "/users/:id", handler: (event) => ({ id: event.context.params?.id }) },
                    ]
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/users/42"))

        expect(await res.json()).toEqual({ id: "42" })

        await runtime.shutdown()
    })

    it("returns 404 for a path with no matching route", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [
                        { method: "GET", path: "/ping", handler: () => ({ pong: true }) },
                    ]
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/nowhere"))

        expect(res.status).toBe(404)

        await runtime.shutdown()
    })

    it("does not dispatch a route to the wrong method", async () => {
        const runtime = await Axon({
            blueprint: {
                server: {
                    routes: [
                        { method: "POST", path: "/ping", handler: () => ({ pong: true }) },
                    ]
                },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/ping"))

        expect(res.status).toBe(404)

        await runtime.shutdown()
    })
})
