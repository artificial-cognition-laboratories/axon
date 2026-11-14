import { describe, expect, it } from "bun:test"
import { errorMap } from "@arcforge/err"
import { AgentRuntime, type RuntimeForAgent } from "../../src/runtime"

/**
 * Who can reach an agent's HTTP surface. A local agent has no deployment key,
 * so its own gate is open — the binding and the serve token are the only
 * things between it and whoever can reach the port.
 */
function runtime(): RuntimeForAgent {
    return {
        kernel: { request: async () => ({}), ingest: async () => {}, interrupt: () => {}, run: async () => ({}) },
        server: { get handler() { return () => new Response("served") } },
        axon: { prompt: async () => "", prompts: { list: () => [], renderEntry: async () => "" } },
        update: async () => ({}),
        shutdown: async () => ({}),
    }
}

const TOKEN = "a".repeat(64)

describe("serving an agent", () => {
    it("with a token, refuses a request without it and serves one with it", async () => {
        const { port } = await AgentRuntime(runtime()).serve({ port: 0, host: "loopback", token: TOKEN })

        expect((await fetch(`http://127.0.0.1:${port}/_axon/health`)).status).toBe(401)
        expect((await fetch(`http://127.0.0.1:${port}/_axon/health`, { headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(401)
        const served = await fetch(`http://127.0.0.1:${port}/_axon/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
        expect(await served.text()).toBe("served")
    })

    it("is idempotent on the same terms and refuses different ones", async () => {
        const agent = AgentRuntime(runtime())
        const first = await agent.serve({ port: 0, host: "loopback", token: TOKEN })

        expect(await agent.serve({ port: 0, host: "loopback", token: TOKEN })).toEqual(first)
        await expect(agent.serve({ port: 0, host: "all", token: null }))
            .rejects.toThrow(expect.objectContaining({ code: errorMap.AGENT_SERVE_CONFLICT.code }))
    })

    it("on loopback, is not bound to the machine's other addresses", async () => {
        const { port } = await AgentRuntime(runtime()).serve({ port: 0, host: "loopback", token: null })
        const external = Object.values((await import("node:os")).networkInterfaces()).flat()
            .find(address => address && address.family === "IPv4" && !address.internal)
        if (!external) return

        await expect(fetch(`http://${external.address}:${port}/`)).rejects.toThrow()
    })
})
