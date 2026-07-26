import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * The framework-reserved /_axon/* surface — behaviour-driven, through the real
 * server fetch handler. This is the wire contract AxonCloud.attach() speaks to,
 * so we exercise it exactly as a remote client would: an HTTP Request in, a
 * Response out. No internals — the handler is the public boundary.
 */
describe("/_axon endpoints", () => {
    function call(runtime: Awaited<ReturnType<typeof Axon>>, path: string, init?: RequestInit) {
        return runtime.server.handler(new Request(`http://agent${path}`, init))
    }

    it("GET /_axon/health returns ok once the runtime is serving", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock() } } })

        const res = await call(runtime, "/_axon/health")
        expect(res.status).toBe(200)
        const health = await res.json()
        expect(health.ok).toBe(true)
        expect(typeof health.sessionId).toBe("string")

        await runtime.shutdown()
    })

    it("POST /_axon/request runs an invocation and returns AxonResult JSON", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } } })

        const res = await call(runtime, "/_axon/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hello" }),
        })

        expect(res.status).toBe(200)
        const result = await res.json()
        expect(result.text).toBe("Hi there!")
        expect(Array.isArray(result.entries)).toBe(true)

        await runtime.shutdown()
    })

    it("POST /_axon/request rejects a body with no usable prompt", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock() } } })

        const res = await call(runtime, "/_axon/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notAPrompt: 1 }),
        })

        expect(res.status).toBe(400)

        await runtime.shutdown()
    })

    it("POST /_axon/stream streams AxonEntry events as SSE and closes with a done frame", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock({ hello: "Hi there!" }) } } })

        const res = await call(runtime, "/_axon/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "hello" }),
        })

        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")

        const text = await res.text()
        // At least one data frame, terminated by the explicit done event.
        expect(text).toContain("data:")
        expect(text).toContain("event: done")

        await runtime.shutdown()
    })

    it("the /_axon surface is present regardless of user routes (empty blueprint)", async () => {
        const runtime = await Axon({ blueprint: { config: { engine: Mock() } } })

        // No user routes declared, yet the framework surface answers.
        expect((await call(runtime, "/_axon/health")).status).toBe(200)

        await runtime.shutdown()
    })
})
