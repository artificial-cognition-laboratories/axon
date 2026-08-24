import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import { Agents } from "@arclabs/cloud"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * The connect gate over a REAL HTTP server.
 *
 * connect-auth.test.ts drives the gate directly and connect-e2e.test.ts wires
 * the backend's actual minter to it; this covers the third thing neither
 * does — that the rejections survive a genuine socket, with real status codes
 * reaching a real client, rather than only working against an in-process
 * handler call.
 */

/**
 * Mint a connect token exactly as the backend's Connect() does.
 *
 * Written out rather than imported from apps/backend: the two are separately
 * deployed systems that share no modules and pin different major versions of
 * jose, so a cross-boundary import pulls a second copy into this process and
 * fails at runtime. The two scope vocabularies are compared directly in
 * connect-auth.test.ts, which is where that agreement belongs.
 */
async function mint(privateKey: CryptoKey, overrides?: { aud?: string; scope?: string[] }): Promise<string> {
    return new SignJWT({ scope: overrides?.scope ?? ["request", "stream", "read"] })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer("axon-backend")
        .setSubject("u1")
        .setAudience(overrides?.aud ?? "agent-1")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(privateKey)
}

describe("Connect gate over HTTP", () => {
    async function deployed() {
        const pair = await generateKeyPair("RS256", { extractable: true })
        const publicKey = await exportSPKI(pair.publicKey)

        const runtime = await Axon({
            blueprint: {
                config: { providers: [Mock({ hello: "Hi there!" })] },
                env: { AXON_JWT_PUBLIC_KEY: publicKey, AGENT_ID: "agent-1" },
            },
        })
        const server = Bun.serve({ port: 0, fetch: req => runtime.server.handler(req) })

        return {
            url: `http://localhost:${server.port}`,
            privateKey: pair.privateKey,
            async stop() {
                server.stop(true)
                await runtime.shutdown()
            },
        }
    }

    function invoke(url: string, token?: string): Promise<Response> {
        return fetch(`${url}/_axon/request`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ prompt: "hello" }),
        })
    }

    it("401s an unauthenticated request", async () => {
        const agent = await deployed()
        try {
            expect((await invoke(agent.url)).status).toBe(401)
        } finally {
            await agent.stop()
        }
    })

    it("401s a token that is not ours", async () => {
        const agent = await deployed()
        try {
            expect((await invoke(agent.url, "not-a-real-token")).status).toBe(401)
        } finally {
            await agent.stop()
        }
    })

    it("401s a genuine token minted for another agent", async () => {
        const agent = await deployed()
        try {
            const token = await mint(agent.privateKey, { aud: "some-other-agent" })
            expect((await invoke(agent.url, token)).status).toBe(401)
        } finally {
            await agent.stop()
        }
    })

    it("403s a token that does not grant invocation", async () => {
        const agent = await deployed()
        try {
            const token = await mint(agent.privateKey, { scope: ["read"] })
            expect((await invoke(agent.url, token)).status).toBe(403)
        } finally {
            await agent.stop()
        }
    })

    it("serves a real result for a valid token", async () => {
        const agent = await deployed()
        try {
            const token = await mint(agent.privateKey)
            const response = await invoke(agent.url, token)

            expect(response.status).toBe(200)
            expect((await response.json()).text).toBe("Hi there!")
        } finally {
            await agent.stop()
        }
    })

    it("leaves health open — the startup probe runs before any caller exists", async () => {
        const agent = await deployed()
        try {
            expect((await fetch(`${agent.url}/_axon/health`)).status).toBe(200)
        } finally {
            await agent.stop()
        }
    })

    it("attach presents a token the gate accepts", async () => {
        const agent = await deployed()
        try {
            const token = await mint(agent.privateKey)
            const { axon } = await Agents().attach(agent.url, { token })

            expect((await axon.request("hello")).text).toBe("Hi there!")
        } finally {
            await agent.stop()
        }
    })
})
