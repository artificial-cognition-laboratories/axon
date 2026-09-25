import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { Boot } from "../../lifecycle"

/**
 * The container lifecycle, behaviour-driven. Boot composes Hydrate → Blueprint
 * → Axon → Serve; we exercise it exactly as the container does — point it at a
 * real prepared agent, then reach the running agent over HTTP through its
 * /_axon surface. No internals.
 *
 * We boot barry.mk3 — a real, prepared agent (has its .agent/cognet compiled),
 * which is what the container actually receives. A synthetic config-only dir
 * can't stand in: a bootable agent needs its compiled cognet, so the honest
 * fixture is a prepared agent on disk.
 */
const AGENT = join(import.meta.dir, "../../../../../../registry/agents/barry.mk3")

describe("Boot", () => {
    it("boots a prepared agent and serves /_axon/health with a session id", async () => {
        const served = await Boot({ agentRoot: AGENT, port: 0 })
        try {
            const res = await fetch(`http://localhost:${served.port}/_axon/health`)
            expect(res.status).toBe(200)
            const health = (await res.json()) as { ok: boolean; sessionId: string }
            expect(health.ok).toBe(true)
            expect(typeof health.sessionId).toBe("string")
            expect(health.sessionId.length).toBeGreaterThan(0)
        } finally {
            await served.stop()
        }
    })

    it("a booted agent propagates an unavailable engine as a request failure", async () => {
        const served = await Boot({ agentRoot: AGENT, port: 0 })
        try {
            const res = await fetch(`http://localhost:${served.port}/_axon/request`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "ping" }),
            })
            expect(res.status).toBe(500)
        } finally {
            await served.stop()
        }
    })
})
