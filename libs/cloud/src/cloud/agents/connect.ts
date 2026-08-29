import type { ConnectScope, ConnectTokenResponse } from "@arcforge/types"

type ConnectOpts = {
    /** Backend transport — the caller's own credential rides on this. */
    http: { post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> }
}

/**
 * Connect — obtaining and refreshing the capability tokens a client presents
 * to a deployed agent.
 *
 * The client's own credential (a session or an API key) is used ONCE, here,
 * to ask the control plane for a token scoped to one agent. That token is
 * what travels to the agent — never the credential itself, which is valid
 * against every other agent and the whole backend API.
 *
 * Tokens are short-lived by design, so this caches per agent and refreshes
 * before expiry rather than making the caller think about lifetimes. The
 * refresh margin is generous: re-minting early costs one cheap backend call,
 * while re-minting late costs a failed request in the middle of a
 * conversation.
 */

/** Re-mint once the token is within this many seconds of expiring. */
const REFRESH_MARGIN_SECONDS = 120

type Cached = {
    token: string
    /** Epoch seconds. */
    expiresAt: number
    scopes: ConnectScope[]
}

export function Connect(opts: ConnectOpts) {
    const cache = new Map<string, Cached>()

    /** In-flight mints, so N concurrent calls for one agent make one request. */
    const inflight = new Map<string, Promise<Cached>>()

    function fresh(entry: Cached | undefined): entry is Cached {
        return entry !== undefined && entry.expiresAt - REFRESH_MARGIN_SECONDS > Math.floor(Date.now() / 1000)
    }

    async function mint(agentId: string): Promise<Cached> {
        const response = await opts.http.post<ConnectTokenResponse>(`/api/agents/${agentId}/connect-token`)
        const entry: Cached = {
            token: response.token,
            expiresAt: Math.floor(Date.now() / 1000) + response.expiresIn,
            scopes: response.scopes,
        }
        cache.set(agentId, entry)
        return entry
    }

    return {
        /**
         * A valid connect token for this agent, minting or refreshing as
         * needed. Concurrent callers share one in-flight request.
         */
        async token(agentId: string): Promise<string> {
            const cached = cache.get(agentId)
            if (fresh(cached)) return cached.token

            const pending = inflight.get(agentId)
            if (pending) return (await pending).token

            const request = mint(agentId).finally(() => inflight.delete(agentId))
            inflight.set(agentId, request)
            return (await request).token
        },

        /**
         * Drop a cached token. For a caller that saw a 401 and wants the next
         * attempt to mint fresh rather than re-present something the agent has
         * already rejected.
         */
        forget(agentId: string): void {
            cache.delete(agentId)
        },
    }
}

export type ConnectT = ReturnType<typeof Connect>
