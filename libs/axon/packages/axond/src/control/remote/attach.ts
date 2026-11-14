import { err } from "@arcforge/err"
import type { AgentsT } from "../../agents/index"
import type { Peer } from "./types"

/** One HTTP request from another machine, for one agent's surface. */
export type AttachRequest = {
    session: string
    method: string
    /** Path and query, e.g. `/_axon/events?since=4`. */
    path: string
    headers: Record<string, string>
    body: string | null
}

/** Headers that describe the hop rather than the request, or carry the caller's own credential. */
const DROPPED = new Set(["authorization", "host", "connection", "content-length", "transfer-encoding"])

/**
 * Attach — another machine talking to an agent here, over the agent's own
 * `/_axon/*` contract: the same one a deployed agent serves and
 * `AxonCloud().agents.attach()` speaks. One protocol for every way an agent is
 * reached.
 *
 * Only that contract crosses — never the agent's authored routes — and only
 * for an agent this daemon runs in its own store. The agent is reached on
 * loopback with a token this daemon holds; the caller's credential, if it sent
 * one, is dropped rather than forwarded.
 */
export function Attach(opts: { agents: AgentsT }) {
    return async function attach(peer: Peer, request: AttachRequest): Promise<Response> {
        if (!request.path.startsWith("/_axon/")) {
            throw err("NET_REFUSED", { detail: `only an agent's /_axon/ surface can be reached from another machine, not ${request.path}`, context: { peer: peer.machine } })
        }
        if (!opts.agents.own.list().some(record => record.sessionId === request.session)) {
            throw err("AGENT_NOT_FOUND", { detail: `no agent with session ${request.session} is running in this machine's store`, context: { session: request.session } })
        }
        const surface = await opts.agents.surface(request.session)
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) {
            if (!DROPPED.has(name.toLowerCase())) headers.set(name, value)
        }
        headers.set("authorization", `Bearer ${surface.token}`)
        return fetch(`http://127.0.0.1:${surface.port}${request.path}`, {
            method: request.method,
            headers: headers,
            ...(request.body !== null && request.method !== "GET" && request.method !== "HEAD" ? { body: request.body } : {}),
        })
    }
}

export type AttachT = ReturnType<typeof Attach>
