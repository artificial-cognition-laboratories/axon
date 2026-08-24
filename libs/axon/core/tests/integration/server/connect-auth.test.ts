import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { ConnectAuth } from "../../../src/runtime/server/connect-auth"
import type { ConnectScope } from "@arcforge/types"

/**
 * The connect gate — the agent's security boundary, asserted.
 *
 * A deployed agent verifies a short-lived capability token LOCALLY against the
 * public key it was deployed with: no network, no database, no dependency on
 * the control plane being reachable. Every property that makes that safe is
 * pinned here, because each one is the whole reason the design works:
 *
 *   - a valid signature from the wrong issuer is refused
 *   - a valid signature for ANOTHER agent is refused (the audience bind)
 *   - an expired token is refused
 *   - a tampered token is refused
 *   - a token that does not grant the scope a route needs is refused
 *
 * These run against real RS256 keys generated per suite, not mocks — the
 * thing under test is cryptographic verification, and a fake verifier would
 * assert nothing.
 */

const ISSUER = "axon-backend"
const AGENT = "agent-under-test"

let privateKeyPem: string
let publicKeyPem: string
let otherPublicKeyPem: string

beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true })
    privateKeyPem = await exportPKCS8(pair.privateKey)
    publicKeyPem = await exportSPKI(pair.publicKey)

    // A second, unrelated keypair — stands in for "signed by something that
    // is not our control plane".
    const other = await generateKeyPair("RS256", { extractable: true })
    otherPublicKeyPem = await exportSPKI(other.publicKey)
})

/** Mint a token the way the backend does, with per-test overrides. */
async function mint(overrides?: {
    sub?: string
    aud?: string
    issuer?: string
    scope?: string[]
    expiresIn?: string
    key?: string
}): Promise<string> {
    const { importPKCS8 } = await import("jose")
    const key = await importPKCS8(overrides?.key ?? privateKeyPem, "RS256")
    return new SignJWT({ scope: overrides?.scope ?? ["request", "stream", "read"] })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(overrides?.issuer ?? ISSUER)
        .setSubject(overrides?.sub ?? "user-1")
        .setAudience(overrides?.aud ?? AGENT)
        .setIssuedAt()
        .setExpirationTime(overrides?.expiresIn ?? "15m")
        .sign(key)
}

/** Minimal H3-event stand-in carrying just the Authorization header the gate reads. */
function eventWith(token?: string): never {
    return { node: { req: { headers: token ? { authorization: `Bearer ${token}` } : {} } } } as never
}

async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
    try {
        await fn()
        return undefined
    } catch (cause) {
        return (cause as { statusCode?: number }).statusCode
    }
}

function gate(overrides?: { publicKey?: string; agentId?: string }) {
    return ConnectAuth({
        publicKey: overrides?.publicKey ?? publicKeyPem,
        agentId: overrides?.agentId ?? AGENT,
    })
}

describe("ConnectAuth", () => {
    describe("when no key is configured", () => {
        it("is open — a local agent is already inside its owner's trust boundary", async () => {
            const auth = ConnectAuth({})
            expect(auth.enforcing).toBe(false)
            // No token, no key, no throw.
            expect(await auth.require(eventWith(), "request")).toBeNull()
        })

        it("stays open with a key but no agent id — there is no audience to bind to", async () => {
            const auth = ConnectAuth({ publicKey: publicKeyPem })
            expect(auth.enforcing).toBe(false)
            expect(await auth.require(eventWith(), "request")).toBeNull()
        })
    })

    describe("when deployed", () => {
        it("accepts a well-formed token and reports the grant", async () => {
            const auth = gate()
            expect(auth.enforcing).toBe(true)

            const grant = await auth.require(eventWith(await mint()), "request")

            expect(grant?.user).toBe("user-1")
            expect(grant?.agent).toBe(AGENT)
            expect(grant?.scopes).toContain("request")
            expect(grant?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
        })

        it("401s when no token is presented", async () => {
            expect(await statusOf(() => gate().require(eventWith(), "request"))).toBe(401)
        })

        it("401s a token signed by a different key", async () => {
            // Valid JWT, valid claims — but our public key cannot verify it.
            const auth = gate({ publicKey: otherPublicKeyPem })
            const token = await mint()
            expect(await statusOf(() => auth.require(eventWith(token), "request"))).toBe(401)
        })

        it("401s a token minted for ANOTHER agent", async () => {
            // The audience bind. The signature is perfectly valid and the
            // issuer is right — this is the property that stops a token for
            // agent A being replayed against agent B.
            const token = await mint({ aud: "some-other-agent" })
            expect(await statusOf(() => gate().require(eventWith(token), "request"))).toBe(401)
        })

        it("401s a token from an unexpected issuer", async () => {
            const token = await mint({ issuer: "not-our-control-plane" })
            expect(await statusOf(() => gate().require(eventWith(token), "request"))).toBe(401)
        })

        it("401s an expired token", async () => {
            const token = await mint({ expiresIn: "-1s" })
            expect(await statusOf(() => gate().require(eventWith(token), "request"))).toBe(401)
        })

        it("401s a tampered token", async () => {
            const token = await mint()
            // Flip a character in the payload segment — signature no longer matches.
            const [header, payload, signature] = token.split(".")
            const tampered = `${header}.${payload!.slice(0, -2)}XY.${signature}`
            expect(await statusOf(() => gate().require(eventWith(tampered), "request"))).toBe(401)
        })

        it("401s a garbage bearer value", async () => {
            expect(await statusOf(() => gate().require(eventWith("not-a-jwt"), "request"))).toBe(401)
        })
    })

    describe("scopes", () => {
        it("403s when the token does not grant the scope the route needs", async () => {
            // A read-only grant must not be able to invoke the agent — this is
            // what makes narrower per-caller grants possible later without a
            // token-format change.
            const token = await mint({ scope: ["read"] })
            expect(await statusOf(() => gate().require(eventWith(token), "request"))).toBe(403)
        })

        it("allows the scope it does grant", async () => {
            const token = await mint({ scope: ["read"] })
            const grant = await gate().require(eventWith(token), "read")
            expect(grant?.scopes).toEqual(["read"])
        })

        it("ignores unknown scope values rather than trusting them", async () => {
            const token = await mint({ scope: ["read", "not-a-real-scope"] })
            const grant = await gate().require(eventWith(token), "read")
            expect(grant?.scopes).toEqual(["read"])
        })

        it("403s a token carrying no scopes at all", async () => {
            const token = await mint({ scope: [] })
            expect(await statusOf(() => gate().require(eventWith(token), "request"))).toBe(403)
        })
    })

    describe("the scope vocabulary", () => {
        it("matches what the backend mints", async () => {
            // The backend declares its own copy (it does not depend on
            // @arcforge/types), so the two lists are kept in step by this
            // assertion rather than by a shared import. If they drift, either
            // callers are locked out or a claim goes unchecked.
            const { CONNECT_SCOPES: backendScopes } = await import(
                "../../../../../../apps/backend/platform/auth/connect"
            )
            const { CONNECT_SCOPES: runtimeScopes } = await import("@arcforge/types")

            expect([...backendScopes].sort()).toEqual([...(runtimeScopes as readonly ConnectScope[])].sort())
        })
    })
})
