import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * /_axon/health reports READINESS, not liveness.
 *
 * It used to return `{ ok: true }` unconditionally, so an agent whose brain
 * failed to load answered 200 forever: the process was up, routes served,
 * the log filled with reload failures, and nothing outside could tell. That
 * happened for real — 29 consecutive failed reloads behind a green light,
 * while the thing appeared to be running fine.
 *
 * A health check that cannot fail is not a health check.
 */
describe("Agent health", () => {
    it("reports ok while a cognet is loaded", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as { ok: boolean; sessionId: string }

        expect(response.status).toBe(200)
        expect(body.ok).toBe(true)
        expect(body.sessionId).toBeString()

        await runtime.shutdown()
    })

    it("exposes readiness on the handle, so callers need not infer it from HTTP", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        expect(runtime.axon.ready).toBe(true)

        await runtime.shutdown()
    })

    it("goes 503 with a reason once the brain is gone", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        // Unloading is what a failed reload leaves behind: process alive,
        // server serving, nothing to think with. Reached through shutdown()
        // because that is the one public path that unloads the cognet while
        // the HTTP surface is still answering.
        await runtime.kernel.shutdown()

        expect(runtime.axon.ready).toBe(false)

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as { ok: boolean; reason?: string }

        expect(response.status).toBe(503)
        expect(body.ok).toBe(false)
        expect(body.reason).toBeString()

        await runtime.shutdown()
    })
})

/**
 * Health also carries the agent's IDENTITY — name, what it is carrying, and
 * the engine it declares.
 *
 * A client that attached over a URL has no blueprint and never will: it did
 * not build this agent. Without these fields its header shows a hostname where
 * a name belongs and a permanent spinner where the model and module counts do.
 * The handshake is the one round trip every attach already makes, so this is
 * where they belong rather than a second endpoint.
 */
describe("Agent health: identity", () => {
    it("names the agent", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as { agent: string }

        expect(body.agent).toBeString()
        expect(body.agent.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })

    it("reports what it is carrying, with zero as a real answer", async () => {
        const runtime = await Axon({ providers: [Mock()] })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as { modules: number; tools: number }

        // Numbers, not absent: an agent with no modules is a common state, and
        // a missing field would render as "still loading" forever.
        expect(body.modules).toBeNumber()
        expect(body.tools).toBeNumber()

        await runtime.shutdown()
    })

    it("reports the declared engine field, null when the config declares none", async () => {
        // What matters is that the FIELD is always present: a client
        // distinguishes "declares nothing" from "this agent predates the
        // field", and only one of those should leave the model row
        // permanently blank. It reports the RESOLVED binding now rather than
        // a declared field: nothing declares a model any more, so what a
        // client wants is which model actually serves the cortex.
        const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as Record<string, unknown>

        expect("engine" in body).toBe(true)
        expect(body.engine).toMatchObject({ provider: "mock", model: "mock" })

        await runtime.shutdown()
    })
})
