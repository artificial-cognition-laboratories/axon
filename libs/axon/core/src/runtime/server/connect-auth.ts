import { createError, getHeader, type H3Event } from "h3"
import { importSPKI, jwtVerify } from "jose"
import { isConnectScope, type ConnectGrant, type ConnectScope } from "@arcforge/types"

/**
 * ConnectAuth — the gate in front of the agent's own /_axon surface.
 *
 * A deployed agent is a separate process with no database, so it cannot
 * answer "may this caller talk to me" from first principles. It does not have
 * to: the control plane already answered, once, when it minted the caller's
 * token. What arrives here is a CAPABILITY — signed by the backend's private
 * key, addressed to this agent by id, and valid for minutes — so the check is
 * a local signature verification. No network call, no shared database, no
 * dependency on the control plane being reachable.
 *
 * This replaces a design where the agent POSTed the caller's bearer token to
 * the backend on every request. That cost a round trip per message, chained
 * the agent's availability to the backend's, and — the real problem — meant
 * the thing presented to the agent was the caller's own full credential,
 * valid against every other agent and every backend route. A connect token is
 * valid for exactly one agent and nothing else.
 *
 * WHEN THE GATE IS OPEN. With no public key configured — local dev, tests, an
 * agent run outside the deploy pipeline — there is nothing to verify against
 * and the gate is open: a locally-run agent is already inside its owner's
 * trust boundary. It engages for a real deployment, which is exactly where
 * the /_axon surface is publicly reachable. `AXON_JWT_PUBLIC_KEY` is injected
 * into every Cloud Run deployment, so "deployed" and "enforcing" coincide.
 *
 * Health is never gated — the startup probe hits it before any caller exists.
 */
export type ConnectAuth = {
    /**
     * Throws 401/403 if the request may not proceed; resolves the grant when
     * it may. Returns null when the gate is open — no token was required, so
     * there is no grant to report.
     */
    require(event: H3Event, scope: ConnectScope): Promise<ConnectGrant | null>
    /** Whether the gate is actually enforcing (a verification key was configured). */
    readonly enforcing: boolean
}

type ConnectAuthOpts = {
    /** RS256 public key PEM. Absent → gate open. */
    publicKey?: string
    /** This agent's registry id — the audience every accepted token must name. Absent → gate open. */
    agentId?: string
    /** The expected `iss`. Defaults to the platform issuer. */
    issuer?: string
}

const DEFAULT_ISSUER = "axon-backend"

export function ConnectAuth(opts: ConnectAuthOpts): ConnectAuth {
    const enforcing = Boolean(opts.publicKey && opts.agentId)
    const issuer = opts.issuer ?? DEFAULT_ISSUER

    /**
     * Parsed once. The PEM never changes, and this sits on the request path of
     * every call to a deployed agent — a key import per request would be a
     * self-inflicted cost.
     */
    let keyPromise: Promise<CryptoKey> | null = null

    function key(): Promise<CryptoKey> {
        // Env vars carry PEMs with escaped newlines; a real PEM needs them back.
        keyPromise ??= importSPKI(opts.publicKey!.replace(/\\n/g, "\n"), "RS256")
        return keyPromise
    }

    async function require(event: H3Event, scope: ConnectScope): Promise<ConnectGrant | null> {
        if (!enforcing) return null

        const header = getHeader(event, "authorization")
        const token = header?.startsWith("Bearer ") ? header.slice(7) : null
        if (!token) {
            throw createError({ statusCode: 401, statusMessage: "connect: missing bearer token" })
        }

        let grant: ConnectGrant
        try {
            // jwtVerify checks the signature, `iss`, `aud` and `exp` together.
            // Audience is the load-bearing one: a token minted for another
            // agent has a perfectly valid signature and must still be refused.
            const { payload } = await jwtVerify(token, await key(), {
                issuer,
                audience: opts.agentId!,
                algorithms: ["RS256"],
            })

            if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
                throw createError({ statusCode: 401, statusMessage: "connect: token is missing required claims" })
            }

            const claimed = Array.isArray(payload.scope) ? payload.scope : []
            grant = {
                user: payload.sub,
                agent: opts.agentId!,
                scopes: claimed.filter((value): value is ConnectScope => typeof value === "string" && isConnectScope(value)),
                expiresAt: payload.exp,
            }
        } catch (cause) {
            if (isH3Error(cause)) throw cause
            // Every verification failure — bad signature, wrong audience,
            // expired, malformed — is one 401. Distinguishing them for the
            // caller would only help someone probing for which part they got
            // wrong; the agent's own log carries the detail.
            throw createError({ statusCode: 401, statusMessage: "connect: invalid or expired token" })
        }

        if (!grant.scopes.includes(scope)) {
            throw createError({ statusCode: 403, statusMessage: `connect: token does not grant "${scope}"` })
        }

        return grant
    }

    return { require, enforcing }
}

function isH3Error(value: unknown): boolean {
    return typeof value === "object" && value !== null && "statusCode" in value
}
