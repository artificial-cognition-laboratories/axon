import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"
import { Connect } from "../../../../../../apps/backend/platform/auth/connect"

/**
 * The connect path end to end: the backend's real signer, the runtime's real
 * verifier, a real HTTP request to a real agent.
 *
 * The two halves are deployed separately and share no code (the backend does
 * not depend on @arcforge/types), so "they agree" is exactly the thing that
 * can silently stop being true. Mocking either side would assert nothing;
 * this wires the actual Connect() minter to the actual ConnectAuth() gate.
 */

const AGENT_ID = "agent-e2e"

let minter: ReturnType<typeof Connect>
let publicKeyPem: string
let otherMinter: ReturnType<typeof Connect>

beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true })
    publicKeyPem = await exportSPKI(pair.publicKey)
    minter = Connect({ privateKey: await exportPKCS8(pair.privateKey) })

    // A minter with a different key — stands in for a forged token.
    const other = await generateKeyPair("RS256", { extractable: true })
    otherMinter = Connect({ privateKey: await exportPKCS8(other.privateKey) })
})

/** A deployed agent: has the public key and knows its own id, so it enforces. */
function deployed() {
    return Axon({
        blueprint: {
            config: { providers: [Mock({ hello: "hi" })] },
            env: { AXON_JWT_PUBLIC_KEY: publicKeyPem, AGENT_ID: AGENT_ID },
        },
    })
}

function bearer(token: string): RequestInit {
    return { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "hi" }) }
}

describe("Connect end to end", () => {
    it("a token minted by the backend is accepted by the agent", async () => {
        const runtime = await deployed()
        const token = await minter.mint({ sub: "user-1", aud: AGENT_ID, scope: ["request", "stream", "read"] })

        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", bearer(token)),
        )

        expect(response.status).toBe(200)
        await runtime.shutdown()
    })

    it("refuses a request with no token", async () => {
        const runtime = await deployed()

        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }),
        )

        expect(response.status).toBe(401)
        await runtime.shutdown()
    })

    it("refuses a token minted for a DIFFERENT agent", async () => {
        // The audience bind, across the real seam: this token is genuinely
        // signed by the control plane and is still worthless here.
        const runtime = await deployed()
        const token = await minter.mint({ sub: "user-1", aud: "some-other-agent", scope: ["request"] })

        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", bearer(token)),
        )

        expect(response.status).toBe(401)
        await runtime.shutdown()
    })

    it("refuses a token signed by anything but the control plane", async () => {
        const runtime = await deployed()
        const forged = await otherMinter.mint({ sub: "user-1", aud: AGENT_ID, scope: ["request"] })

        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", bearer(forged)),
        )

        expect(response.status).toBe(401)
        await runtime.shutdown()
    })

    it("refuses an invocation when the token only grants read", async () => {
        const runtime = await deployed()
        const readOnly = await minter.mint({ sub: "user-1", aud: AGENT_ID, scope: ["read"] })

        const invoke = await runtime.server.handler(
            new Request("http://localhost/_axon/request", bearer(readOnly)),
        )
        expect(invoke.status).toBe(403)

        // ...but the same token reads the session fine.
        const read = await runtime.server.handler(
            new Request("http://localhost/_axon/session", { headers: { authorization: `Bearer ${readOnly}` } }),
        )
        expect(read.status).toBe(200)

        await runtime.shutdown()
    })

    it("never gates health — the startup probe runs before any caller exists", async () => {
        const runtime = await deployed()

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))

        expect(response.status).toBe(200)
        await runtime.shutdown()
    })

    it("stays open when the agent has no key — a local agent is inside its owner's boundary", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi" })] } } })

        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: "hi" }),
            }),
        )

        expect(response.status).toBe(200)
        await runtime.shutdown()
    })

    it("does not verify against the control plane — no network on the request path", async () => {
        // The whole point of the design. If verification ever reaches for the
        // network again, this fails.
        const runtime = await deployed()
        const token = await minter.mint({ sub: "user-1", aud: AGENT_ID, scope: ["request"] })

        const realFetch = globalThis.fetch
        let fetched = 0
        globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
            fetched += 1
            return realFetch(...args)
        }) as typeof fetch

        try {
            const response = await runtime.server.handler(
                new Request("http://localhost/_axon/request", bearer(token)),
            )
            expect(response.status).toBe(200)
            expect(fetched).toBe(0)
        } finally {
            globalThis.fetch = realFetch
        }

        await runtime.shutdown()
    })
})

/**
 * An agent that enforces must SAY which audience to mint for.
 *
 * `/_axon/health` is ungated by design — the startup probe hits it before any
 * caller exists — which makes it the one place a client holding nothing but a
 * URL can learn what to ask the backend for. Without it, `:attach <url>` sent
 * no token and every gated route answered `401: connect: missing bearer
 * token`, naming nothing the user could act on.
 *
 * The assumption underneath was "local means the gate is open", which stopped
 * being true when local staging began deploying through the real pipeline:
 * those agents are local AND enforcing.
 */
describe("Connect discovery", () => {
    it("publishes the audience on health when the gate is enforcing", async () => {
        const runtime = await deployed()

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const health = await response.json() as { agentId?: string }

        expect(health.agentId).toBe(AGENT_ID)
        await runtime.shutdown()
    })

    it("publishes NO audience when the gate is open", async () => {
        // Absence is the honest signal that no token is needed, rather than an
        // id a client would then mint against for nothing.
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi" })] } } })

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))
        const health = await response.json() as { agentId?: string }

        expect(health.agentId).toBeUndefined()
        await runtime.shutdown()
    })

    it("health stays reachable without a token, so discovery is possible at all", async () => {
        const runtime = await deployed()

        const response = await runtime.server.handler(new Request("http://localhost/_axon/health"))

        expect(response.status).toBe(200)
        await runtime.shutdown()
    })

    it("the published audience is the one a working token must name", async () => {
        const runtime = await deployed()
        const health = await (await runtime.server.handler(new Request("http://localhost/_axon/health"))).json() as { agentId: string }

        // Mint for exactly what health advertised — the round trip a client makes.
        const token = await minter.mint({ sub: "user-1", aud: health.agentId, scope: ["request"] })
        const response = await runtime.server.handler(
            new Request("http://localhost/_axon/request", bearer(token)),
        )

        expect(response.status).toBe(200)
        await runtime.shutdown()
    })
})
