/**
 * The connect-token contract — what a caller presents to a deployed agent's
 * /_axon surface, and what that agent checks.
 *
 * Lives in types because it is genuinely shared: the backend mints against
 * this shape and the runtime verifies against it. A drift between the two is
 * an outage (every caller locked out) or a hole (a claim nobody checks), so
 * there is one definition and both sides import it.
 *
 * The token is a CAPABILITY, not an identity. It says "the bearer may do
 * these things, to this one agent, until this time" — it is not the caller's
 * credential and cannot be replayed against another agent or the backend.
 */

/**
 * What a connect token may authorize. Deliberately about the AGENT's surface,
 * not the backend's — `agents:connect` (an API-key scope) is permission to
 * obtain one of these; these are what it lets you do once you have it.
 *
 * Additive only. A token in the wild carries the scopes it was minted with,
 * so removing one silently breaks live callers; widening is safe.
 */
export const CONNECT_SCOPES = ["request", "stream", "read"] as const

export type ConnectScope = (typeof CONNECT_SCOPES)[number]

export function isConnectScope(value: string): value is ConnectScope {
    return (CONNECT_SCOPES as readonly string[]).includes(value)
}

/**
 * Everything a token grants the caller who holds it, once verified.
 *
 * `agent` is the audience the token was minted for. The runtime checks it
 * against its OWN id: a token addressed elsewhere is refused even though its
 * signature is perfectly valid, which is what stops a token for agent A being
 * replayed against agent B.
 */
export type ConnectGrant = {
    /** The user this token acts for. */
    user: string
    /** The one agent it is valid against. */
    agent: string
    scopes: ConnectScope[]
    /** Expiry, epoch seconds — carried so a client can refresh ahead of it. */
    expiresAt: number
}

/** What the backend's connect-token endpoint returns. */
export type ConnectTokenResponse = {
    token: string
    /** Seconds until expiry. A client refreshes on roughly half of this. */
    expiresIn: number
    scopes: ConnectScope[]
}
