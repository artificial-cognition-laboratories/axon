import { createError, defineEventHandler } from "h3"
import type { AxonMiddleware, AxonRoute } from "@arcforge/types"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * Server middleware — the Nitro contract, asserted.
 *
 * `server/middleware/` is one of the three surfaces an agent author writes
 * (routes, plugins, middleware). Its behaviour is not "whatever h3 happens to
 * do": it is a promise the product makes, so each half of it is pinned here.
 *
 *   - runs on EVERY request, ahead of routes AND the reserved /_axon/* surface
 *   - runs in the order the blueprint lists (filename order, from the scanner)
 *   - returning nothing continues; returning a value ends the request with it
 *   - throwing createError(...) rejects with that status
 */
describe("Server middleware", () => {
    /** Records its own name, then optionally acts. */
    function probe(order: string[], name: string, act?: () => unknown): AxonMiddleware {
        return {
            name,
            handler: defineEventHandler(() => {
                order.push(name)
                return act?.()
            }),
        }
    }

    function route(order: string[]): AxonRoute {
        return {
            method: "GET",
            path: "/hello",
            handler: defineEventHandler(() => {
                order.push("route")
                return { ok: true }
            }),
        }
    }

    function runtimeWith(middleware: AxonMiddleware[], routes: AxonRoute[] = []) {
        return Axon({ blueprint: { config: { engine: Mock() }, server: { middleware, routes } } })
    }

    it("runs every middleware in order, then the route", async () => {
        const order: string[] = []
        const runtime = await runtimeWith([probe(order, "first"), probe(order, "second")], [route(order)])

        const response = await runtime.server.handler(new Request("http://localhost/hello"))

        expect(response.status).toBe(200)
        expect(order).toEqual(["first", "second", "route"])

        await runtime.shutdown()
    })

    it("runs on the reserved /_axon surface too, so an auth gate covers everything", async () => {
        const order: string[] = []
        const runtime = await runtimeWith([probe(order, "gate")])

        // /_axon/health is the framework's own endpoint — middleware must
        // still see it, or "authenticate every request" would be a lie.
        await runtime.server.handler(new Request("http://localhost/_axon/health"))

        expect(order).toEqual(["gate"])

        await runtime.shutdown()
    })

    it("ends the request when a middleware returns a value", async () => {
        const order: string[] = []
        const runtime = await runtimeWith(
            [probe(order, "short", () => ({ blocked: true })), probe(order, "never")],
            [route(order)],
        )

        const response = await runtime.server.handler(new Request("http://localhost/hello"))

        expect(await response.json()).toEqual({ blocked: true })
        // neither the following middleware nor the route ran
        expect(order).toEqual(["short"])

        await runtime.shutdown()
    })

    it("rejects with the thrown status and never reaches the route", async () => {
        const order: string[] = []
        const runtime = await runtimeWith(
            [probe(order, "auth", () => { throw createError({ statusCode: 401, statusMessage: "unauthorized" }) })],
            [route(order)],
        )

        const response = await runtime.server.handler(new Request("http://localhost/hello"))

        expect(response.status).toBe(401)
        expect(order).toEqual(["auth"])

        await runtime.shutdown()
    })

    it("continues to the route when a middleware returns nothing", async () => {
        const order: string[] = []
        const runtime = await runtimeWith([probe(order, "observe")], [route(order)])

        const response = await runtime.server.handler(new Request("http://localhost/hello"))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(order).toEqual(["observe", "route"])

        await runtime.shutdown()
    })

    it("survives a reload with the middleware still applied", async () => {
        const order: string[] = []
        const runtime = await runtimeWith([probe(order, "gate")], [route(order)])

        await runtime.update({ server: { middleware: [probe(order, "gate")], routes: [route(order)] } })

        order.length = 0
        await runtime.server.handler(new Request("http://localhost/hello"))
        expect(order).toEqual(["gate", "route"])

        await runtime.shutdown()
    })
})
