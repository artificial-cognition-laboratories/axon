import { errorMap, isAxonError } from "@arcforge/err"
import type { MachinesT } from "../net/index"

/** Where a tunnelled request is addressed on the local socket. */
const ADDRESS = /^\/machines\/([0-9a-f]{64})\/agents\/([^/]+)(\/_axon\/.*)$/

/**
 * Tunnel — an agent on another machine, reached through this daemon's socket.
 *
 * `POST /machines/<key>/agents/<session>/_axon/stream` on the local socket is
 * `POST /_axon/stream` on that agent, carried over the network. It exists so a
 * client can hand `AxonCloud().agents.attach()` a `fetch` and attach to an
 * agent on another box exactly as it attaches to a deployed one.
 *
 * Answers null for anything not addressed this way, which the server then
 * treats as an ordinary verb call.
 */
export function Tunnel(opts: { machines: MachinesT }) {
    return async function tunnel(request: Request): Promise<Response | null> {
        const url = new URL(request.url)
        const match = ADDRESS.exec(url.pathname)
        if (match === null) return null
        const headers: Record<string, string> = {}
        request.headers.forEach((value, name) => { headers[name] = value })
        try {
            return await opts.machines.fetch(match[1]!, {
                session: decodeURIComponent(match[2]!),
                method: request.method,
                path: `${match[3]!}${url.search}`,
                headers: headers,
                body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
            })
        } catch (cause) {
            // An HTTP caller reads statuses, not error codes: answer as an HTTP
            // proxy would, with the reason as the body — never a bare 500 that
            // turns "that agent is not running there" into "something broke".
            const code = isAxonError(cause) ? cause.toJSON().code : null
            const status = code === null ? 502 : STATUS[code] ?? 502
            return new Response(cause instanceof Error ? cause.message : String(cause), { status: status })
        }
    }
}

/** What each failure means to an HTTP caller. Anything else is a bad gateway. */
const STATUS: Record<string, number> = {
    [errorMap.AGENT_NOT_FOUND.code]: 404,
    [errorMap.NET_REFUSED.code]: 403,
    [errorMap.NET_UNREACHABLE.code]: 503,
    [errorMap.NET_SIDECAR_DOWN.code]: 503,
}

export type TunnelT = ReturnType<typeof Tunnel>
