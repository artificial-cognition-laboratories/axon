import { defineEventHandler, createError } from "h3"
import type { AxonRoute } from "@arcforge/types"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * axon:server:request — one durable line per request to the agent's own HTTP
 * surface. A settled fact, not a span: a request has no interesting interior
 * for a flame graph to nest inside, and one line per request is what a server
 * log wants.
 */
describe("Server request log", () => {
    function runtimeWith(routes: AxonRoute[] = []) {
        return Axon({ blueprint: { config: { engine: Mock() }, server: { routes } } })
    }

    function requests(runtime: Awaited<ReturnType<typeof Axon>>) {
        return runtime.session.log.filter(e => e.type === "axon:server:request")
            .map(e => e.data as { method: string; path: string; status: number; durationMs: number })
    }

    it("records method, path, status and duration for an application route", async () => {
        const runtime = await runtimeWith([
            { method: "GET", path: "/hello", handler: defineEventHandler(() => ({ ok: true })) },
        ])

        await runtime.server.handler(new Request("http://localhost/hello"))

        const logged = requests(runtime)
        expect(logged).toHaveLength(1)
        expect(logged[0]?.method).toBe("GET")
        expect(logged[0]?.path).toBe("/hello")
        expect(logged[0]?.status).toBe(200)
        expect(logged[0]?.durationMs).toBeGreaterThanOrEqual(0)

        await runtime.shutdown()
    })

    it("records a failing route with its real status, not a success", async () => {
        const runtime = await runtimeWith([
            {
                method: "GET",
                path: "/boom",
                handler: defineEventHandler(() => { throw createError({ statusCode: 418, message: "teapot" }) }),
            },
        ])

        await runtime.server.handler(new Request("http://localhost/boom"))

        const logged = requests(runtime)
        expect(logged).toHaveLength(1)
        expect(logged[0]?.path).toBe("/boom")
        expect(logged[0]?.status).toBe(418)

        await runtime.shutdown()
    })

    it("never records the framework's own /_axon/* observability surface", async () => {
        const runtime = await runtimeWith()

        await runtime.server.handler(new Request("http://localhost/_axon/health"))
        await runtime.server.handler(new Request("http://localhost/_axon/session"))

        // Logging the observability plane into the log it serves is a feedback
        // loop: a health poll every second would write a line a second forever.
        expect(requests(runtime)).toHaveLength(0)

        await runtime.shutdown()
    })
})
