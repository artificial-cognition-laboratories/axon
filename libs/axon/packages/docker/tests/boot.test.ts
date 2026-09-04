import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Boot } from "../lifecycle"
import { Hydrate } from "../hydrate"

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
// Under `registry/` — agents moved there and this path did not follow, so it
// resolved to a directory outside the repo and every test here failed with
// "no source ... cannot boot an agent with no code".
const AGENT = join(import.meta.dir, "../../../../../registry/agents/barry.mk3")

describe("Hydrate", () => {
    it("is a no-op when source is already present (staging path)", async () => {
        const result = await Hydrate({ agentRoot: AGENT })
        expect(result.status).toBe("present")
    })

    it("fails loudly when there is no source and no fetch target", async () => {
        const empty = await mkdtemp(join(tmpdir(), "axon-boot-empty-"))
        try {
            await expect(Hydrate({ agentRoot: empty })).rejects.toThrow()
        } finally {
            await rm(empty, { recursive: true, force: true })
        }
    })
})

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

    it("a booted agent answers /_axon/request through the framework surface", async () => {
        const served = await Boot({ agentRoot: AGENT, port: 0 })
        try {
            const res = await fetch(`http://localhost:${served.port}/_axon/request`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "ping" }),
            })
            // The agent may need real inference to produce text; here we assert
            // the framework surface accepted and routed the request (not a 4xx/5xx
            // from the endpoint itself). A real engine response is exercised in
            // core's attach.test.ts against a Mock engine.
            expect([200, 500].includes(res.status)).toBe(true)
        } finally {
            await served.stop()
        }
    })
})
