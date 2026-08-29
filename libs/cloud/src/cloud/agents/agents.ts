import type { AxonSessionQuery } from "@arcforge/types"
import { RemoteAgent, type RemoteAgentHandle } from "./remote"
import { Connect } from "./connect"

/** Options for attach(). */
export type AttachOpts = {
    /**
     * The agent's registry id. Supply it and AxonCloud.attach mints a connect
     * token scoped to that agent — the ordinary path for reaching a
     * deployment. Without it (and without an explicit `token`) the agent is
     * attached unauthenticated.
     */
    agentId?: string
    /** A connect token to present, if the caller already holds one. Overrides minting. */
    token?: string
    /**
     * Skip the session hydrate. Only for a caller that wants the handle without
     * paying for history (a health check, a fire-and-forget request) — the
     * default is to hydrate, because a mirror that silently starts empty is the
     * kind of thing that looks like lost messages.
     */
    hydrate?: false
    /** Narrow what the initial hydrate pulls — e.g. omit kernelLog on a long-lived agent. */
    session?: AxonSessionQuery
}

type AgentsOpts = {
    /** Injectable fetch for tests; defaults to global fetch. */
    fetch?: typeof fetch
    /** Backend transport, used to mint connect tokens. Absent → no token minting (tests, offline). */
    http?: { post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> }
}

/** What attach() resolves: the remote handle plus the instance identity it bound to. */
export type AttachResult = {
    /** The consumer-subset handle to this instance — request/stream mirror the local axon handle. */
    axon: RemoteAgentHandle
    /** The agent instance's session id, resolved during attach. */
    sessionId: string
    /**
     * The agent's own name, as the handshake reported it. Empty when the agent
     * predates health carrying one — a caller that typed a bare URL falls back
     * to the address rather than showing nothing.
     */
    agent: string
    /**
     * What the agent is carrying, as IT reports it. Null when the handshake
     * omitted the counts (an older agent) — distinct from zero, which is a
     * real and common state for an agent with no modules.
     */
    loaded: { modules: number; tools: number } | null
    /**
     * The engine the agent DECLARES, flattened. Null when it declares none, or
     * when the handshake predates this field — a client renders the row empty
     * rather than inventing a provider.
     */
    engine: { provider: string; model: string | null } | null
}

/**
 * Agents — attaching to deployed agent instances. `attach(url)` binds a client
 * to ONE running instance and returns a handle whose request/stream mirror the
 * local AxonHandle. The handle is the instance: two attach() calls to the same
 * URL are two independent instance bindings.
 *
 * attach() performs a liveness handshake against the agent's framework
 * /_axon/health endpoint, both to fail fast if the agent is unreachable and to
 * resolve the instance's session id up front, so `sessionId` is known before
 * the first request rather than discovered mid-stream.
 */
export function Agents(opts: AgentsOpts = {}) {
    const connect = opts.http ? Connect({ http: opts.http }) : null

    return {
        /**
         * Connect-token acquisition for deployed agents. Null when this client
         * was built without backend transport — an offline or test client
         * attaches with whatever token it is handed, or none.
         */
        connect: connect,

        async attach(url: string, attachOpts?: AttachOpts): Promise<AttachResult> {
            const doFetch = opts.fetch ?? fetch
            const base = url.replace(/\/+$/, "")

            const res = await doFetch(`${base}/_axon/health`, {
                headers: attachOpts?.token ? { authorization: `Bearer ${attachOpts.token}` } : {},
            }).catch((cause: unknown) => {
                throw new Error(`attach: agent at ${base} is unreachable — ${cause instanceof Error ? cause.message : String(cause)}`)
            })

            if (!res.ok) {
                throw new Error(`attach: agent at ${base} is not ready (${res.status})`)
            }

            const health = (await res.json().catch(() => ({}))) as {
                sessionId?: string
                agent?: string
                modules?: number
                tools?: number
                engine?: { provider: string; model: string | null } | null
                /** Present only when the agent enforces a connect gate — the audience to mint for. */
                agentId?: string
            }
            const sessionId = health.sessionId ?? ""

            // The agent named an audience, so it enforces — mint for it BEFORE
            // touching any gated route.
            //
            // `/_axon/health` is ungated by design (the startup probe hits it
            // before any caller exists), which makes it the one place a client
            // holding nothing but a URL can learn what to ask for. Without
            // this, `:attach <url>` sent no token and every gated route
            // answered `401: connect: missing bearer token` — an error naming
            // nothing the user could act on.
            //
            // The caller's explicit token still wins: a caller that brought its
            // own has said which credential to use, and silently replacing it
            // would be the client overriding an instruction.
            //
            // Minting can legitimately FAIL — the account may not own this
            // agent — and that failure is the real answer, so it propagates
            // rather than falling through to a bare 401.
            const minted = attachOpts?.token
                ?? (health.agentId ? await connect?.token(health.agentId) : undefined)

            const axon = RemoteAgent({
                url: base,
                sessionId,
                ...(minted ? { token: minted } : {}),
                ...(opts.fetch ? { fetch: opts.fetch } : {}),
            })

            // Hydrate the session before returning, so `axon.session.entries` is
            // the agent's real history the moment attach resolves — a consumer
            // never has to know it is holding an empty mirror that fills later.
            // This is what makes a deployed agent render like a local one.
            if (attachOpts?.hydrate !== false) {
                await axon.session.hydrate(attachOpts?.session ?? {})
            }

            return {
                axon,
                sessionId,
                agent: health.agent ?? "",
                loaded: health.modules === undefined || health.tools === undefined
                    ? null
                    : { modules: health.modules, tools: health.tools },
                engine: health.engine ?? null,
            }
        },
    }
}

export type AgentsHandle = ReturnType<typeof Agents>
