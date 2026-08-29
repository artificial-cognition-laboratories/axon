import { DeploymentFailedError, HttpError } from "../../src"
import { Deployment } from "../../src/registry/agents/deployment"

/**
 * What a user is told when a deployment does not come up.
 *
 * This is the money path: a deploy that fails and reports only a UUID is the
 * worst possible outcome for something being paid for. These assert the failure
 * carries a reason, the container's own output, and a phase — and that a
 * permanent error is not mistaken for a transient one.
 *
 * The HTTP client is stubbed so each case is exact: the point under test is what
 * the client does with a given control-plane response, and polling real
 * infrastructure into an error state is neither fast nor deterministic.
 */

type Handler = (path: string) => unknown

function http(handler: Handler) {
    const calls: string[] = []
    const client = {
        get: async (path: string) => { calls.push(path); return handler(path) },
        post: async (path: string) => { calls.push(path); return handler(path) },
        put: async (path: string) => { calls.push(path); return handler(path) },
        del: async (path: string) => { calls.push(path); return handler(path) },
    }
    return { client: client as never, calls }
}

const LOG_ENTRIES = [
    { timestamp: "2026-07-26T12:00:00Z", severity: "ERROR", message: "AX-BOOT-001: agent failed to start" },
    { timestamp: "2026-07-26T12:00:01Z", severity: "ERROR", message: "missing required env DISCORD_BOT_TOKEN" },
]

describe("waitUntilReady failure reporting", () => {
    it("carries the control plane's reason and the container's log tail", async () => {
        const { client } = http(path => {
            if (path.includes("/status")) return { status: "error", lastError: "container failed to start" }
            if (path.includes("/logs")) return { entries: LOG_ENTRIES }
            return {}
        })

        const deployment = Deployment({ id: "dep-1", http: client })
        const error = await deployment.waitUntilReady({ timeoutMs: 10_000, pollMs: 0 }).catch(e => e)

        expect(error).toBeInstanceOf(DeploymentFailedError)
        expect(error.phase).toBe("provisioning")
        expect(error.reason).toBe("container failed to start")
        // The message names the cause — not a bare UUID.
        expect(error.message).toContain("container failed to start")
        // The log tail is what usually explains it.
        expect(error.logs).toHaveLength(2)
        expect(error.logs[1].message).toContain("DISCORD_BOT_TOKEN")
    })

    it("still reports the failure when logs are unreachable", async () => {
        const { client } = http(path => {
            if (path.includes("/status")) return { status: "error", lastError: "insufficient_funds" }
            throw new Error("logs backend down")
        })

        const deployment = Deployment({ id: "dep-2", http: client })
        const error = await deployment.waitUntilReady({ timeoutMs: 10_000, pollMs: 0 }).catch(e => e)

        // Best-effort logs must never mask the actual failure.
        expect(error).toBeInstanceOf(DeploymentFailedError)
        expect(error.reason).toBe("insufficient_funds")
        expect(error.logs).toEqual([])
    })

    it("says so when no reason was recorded, rather than implying success", async () => {
        const { client } = http(path => {
            if (path.includes("/status")) return { status: "error" }
            if (path.includes("/logs")) return { entries: [] }
            return {}
        })

        const deployment = Deployment({ id: "dep-3", http: client })
        const error = await deployment.waitUntilReady({ timeoutMs: 10_000, pollMs: 0 }).catch(e => e)

        expect(error.reason).toBeNull()
        expect(error.message).toContain("no reason recorded")
    })

    it("reports a timeout as a timeout, with whatever the container logged", async () => {
        const { client } = http(path => {
            if (path.includes("/status")) return { status: "provisioning" }
            if (path.includes("/logs")) return { entries: LOG_ENTRIES }
            return {}
        })

        const deployment = Deployment({ id: "dep-4", http: client })
        // Never-ready status + a short deadline: the loop must give up on the
        // deadline, which it reaches immediately when polls do not sleep.
        const error = await deployment.waitUntilReady({ timeoutMs: 25, pollMs: 0 }).catch(e => e)

        expect(error).toBeInstanceOf(DeploymentFailedError)
        expect(error.phase).toBe("timeout")
        expect(error.message).toContain("did not become ready")
        // Even on a timeout the container may already have said why.
        expect(error.logs.length).toBeGreaterThan(0)
    })

    it("fails fast on a 4xx instead of polling until the deadline", async () => {
        // An expired token or a deleted deployment will never resolve. The old
        // code swallowed every status error, so an auth failure spent the full
        // timeout and then reported "not ready" — the wrong diagnosis entirely.
        const { client, calls } = http(() => {
            throw new HttpError(401, "/status", "Unauthorized")
        })

        const deployment = Deployment({ id: "dep-5", http: client })
        const error = await deployment.waitUntilReady({ timeoutMs: 60_000, pollMs: 0 }).catch(e => e)

        expect(error).toBeInstanceOf(HttpError)
        expect(error.status).toBe(401)
        // One status call, not thirty seconds of them.
        expect(calls.filter(call => call.includes("/status"))).toHaveLength(1)
    })

    it("keeps polling through a 5xx — the control plane may come back", async () => {
        let attempts = 0
        const { client } = http(path => {
            if (path.includes("/status")) {
                attempts++
                if (attempts < 3) throw new HttpError(503, "/status", "unavailable")
                return { status: "running", url: "https://agent.example" }
            }
            return {}
        })

        const deployment = Deployment({ id: "dep-6", http: client })
        const result = await deployment.waitUntilReady({ timeoutMs: 20_000, pollMs: 0 })

        expect(result.url).toBe("https://agent.example")
        expect(attempts).toBe(3)
    })
})
