import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

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
        const runtime = await Axon({ engine: Mock() })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const body = await response.json() as { ok: boolean; sessionId: string }

        expect(response.status).toBe(200)
        expect(body.ok).toBe(true)
        expect(body.sessionId).toBeString()

        await runtime.shutdown()
    })

    it("exposes readiness on the handle, so callers need not infer it from HTTP", async () => {
        const runtime = await Axon({ engine: Mock() })

        expect(runtime.axon.ready).toBe(true)

        await runtime.shutdown()
    })

    it("goes 503 with a reason once the brain is gone", async () => {
        const runtime = await Axon({ engine: Mock() })

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
