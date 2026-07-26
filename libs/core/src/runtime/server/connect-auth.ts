import { createError, getHeader, type H3Event } from "h3"

/**
 * ConnectAuth — the gate in front of /_axon/{request,stream}. A deployed agent
 * is a separate process from the control plane, so it delegates "may this
 * caller connect" back to the backend: it POSTs the caller's bearer token to
 * the agent-verify endpoint, which resolves the token and checks access.
 *
 * Configured from env at boot (AXON_API_BASE + AGENT_ID). When those are ABSENT
 * — local dev, tests, an agent run outside the deploy pipeline — the gate is
 * OPEN: there is no control plane to ask, and a locally-run agent is already
 * inside its owner's trust boundary. The gate only engages for a real
 * deployment, which is exactly where the /_axon surface is publicly reachable.
 *
 * Health is never gated (the startup probe needs it); this guard is applied
 * only to the invocation routes.
 */
export type ConnectAuth = {
    /** Throws a 401/403 h3 error if the request may not proceed. No-op when the gate is open. */
    require(event: H3Event): Promise<void>
    /** Whether the gate is actually enforcing (a control plane was configured). */
    readonly enforcing: boolean
}

type ConnectAuthOpts = {
    /** Backend base URL to verify against. Absent → gate open. */
    apiBase?: string
    /** This agent's registry id, sent to the verify endpoint. Absent → gate open. */
    agentId?: string
    /** Injectable for tests. Defaults to global fetch. */
    fetch?: typeof fetch
}

export function ConnectAuth(opts: ConnectAuthOpts): ConnectAuth {
    const enforcing = Boolean(opts.apiBase && opts.agentId)
    const doFetch = opts.fetch ?? fetch

    async function require(event: H3Event): Promise<void> {
        if (!enforcing) return

        const header = getHeader(event, "authorization")
        const token = header?.startsWith("Bearer ") ? header.slice(7) : null
        if (!token) {
            throw createError({ statusCode: 401, statusMessage: "connect: missing bearer token" })
        }

        const url = `${opts.apiBase!.replace(/\/+$/, "")}/api/agents/${opts.agentId}/verify-connect`
        let verdict: { ok?: boolean; reason?: string }
        try {
            const res = await doFetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token }),
            })
            // A backend that errors (5xx, unreachable) must FAIL CLOSED — a
            // verification we couldn't complete is not an approval.
            if (!res.ok) {
                throw createError({ statusCode: 503, statusMessage: "connect: verification unavailable" })
            }
            verdict = (await res.json()) as { ok?: boolean; reason?: string }
        } catch (cause) {
            if (isH3Error(cause)) throw cause
            throw createError({ statusCode: 503, statusMessage: "connect: verification unavailable" })
        }

        if (!verdict.ok) {
            throw createError({ statusCode: 403, statusMessage: `connect: ${verdict.reason ?? "forbidden"}` })
        }
    }

    return { require, enforcing }
}

function isH3Error(value: unknown): boolean {
    return typeof value === "object" && value !== null && "statusCode" in value
}
