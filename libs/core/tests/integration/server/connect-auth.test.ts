import { ConnectAuth } from "../../../src/runtime/server/connect-auth"

/**
 * The connect gate — behaviour at the boundary. We drive it with a fake H3
 * event (just the header shape it reads) and an injected fetch standing in for
 * the control plane's verify endpoint. The gate is the security boundary, so
 * its fail-closed behaviour is asserted explicitly.
 */

/** Minimal H3-event stand-in carrying just the Authorization header the gate reads. */
function eventWith(authHeader?: string): any {
    return { node: { req: { headers: authHeader ? { authorization: authHeader } : {} } } }
}

async function expectThrows(fn: () => Promise<void>): Promise<{ statusCode?: number }> {
    try {
        await fn()
        throw new Error("expected a throw, got none")
    } catch (e) {
        return e as { statusCode?: number }
    }
}

describe("ConnectAuth", () => {
    it("is open (no-op) when no control plane is configured", async () => {
        const auth = ConnectAuth({})
        expect(auth.enforcing).toBe(false)
        // No token, no backend — must not throw.
        await auth.require(eventWith())
    })

    it("enforces when apiBase + agentId are configured", async () => {
        const auth = ConnectAuth({ apiBase: "http://cp", agentId: "a1", fetch: async () => Response.json({ ok: true }) })
        expect(auth.enforcing).toBe(true)
    })

    it("401s when enforcing and no bearer token is presented", async () => {
        const auth = ConnectAuth({ apiBase: "http://cp", agentId: "a1", fetch: async () => Response.json({ ok: true }) })
        const err = await expectThrows(() => auth.require(eventWith()))
        expect(err.statusCode).toBe(401)
    })

    it("403s when the control plane denies", async () => {
        const auth = ConnectAuth({
            apiBase: "http://cp",
            agentId: "a1",
            fetch: async () => Response.json({ ok: false, reason: "forbidden" }),
        })
        const err = await expectThrows(() => auth.require(eventWith("Bearer sometoken")))
        expect(err.statusCode).toBe(403)
    })

    it("passes when the control plane approves", async () => {
        const auth = ConnectAuth({
            apiBase: "http://cp",
            agentId: "a1",
            fetch: async () => Response.json({ ok: true, userId: "u1" }),
        })
        await auth.require(eventWith("Bearer goodtoken"))
    })

    it("fails CLOSED when the control plane is unreachable", async () => {
        const auth = ConnectAuth({
            apiBase: "http://cp",
            agentId: "a1",
            fetch: async () => { throw new Error("network down") },
        })
        const err = await expectThrows(() => auth.require(eventWith("Bearer goodtoken")))
        expect(err.statusCode).toBe(503)
    })

    it("fails CLOSED when the control plane returns an error status", async () => {
        const auth = ConnectAuth({
            apiBase: "http://cp",
            agentId: "a1",
            fetch: async () => new Response("boom", { status: 500 }),
        })
        const err = await expectThrows(() => auth.require(eventWith("Bearer goodtoken")))
        expect(err.statusCode).toBe(503)
    })
})
