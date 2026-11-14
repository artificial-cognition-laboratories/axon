import { request as httpRequest } from "node:http"
import { err } from "@arcforge/err"
import { rebuild } from "./fault"
import type { DaemonPaths } from "../../types/index"

/**
 * One request to the daemon.
 *
 * Owns the client half of the socket's wire: one verb out, and either its
 * value or the domain's own error rebuilt from the fault that crossed.
 */
export function Caller(opts: { paths: DaemonPaths }) {
    return async function call(path: readonly string[], arg?: unknown): Promise<unknown> {
        let response: { status: number; body: string }
        try {
            response = await post(opts.paths.socket, JSON.stringify({ path: path, arg: arg }))
        } catch (cause) {
            // A refused connection is the ordinary "no daemon" case, not a
            // fault — reported as such so a caller can offer `axon daemon up`
            // rather than surfacing a socket error.
            throw err("DAEMON_NOT_RUNNING", {
                detail: `no daemon listening on ${opts.paths.socket}`,
                context: { socket: opts.paths.socket, verb: path.join(".") },
                cause,
            })
        }

        const body = JSON.parse(response.body) as {
            ok: boolean
            value?: unknown
            error?: string
            fault?: { code?: string; message?: string; context?: unknown }
        }
        if (!body.ok) throw rebuild(path, body)
        return body.value
    }
}

/**
 * POST one request over a unix socket.
 *
 * `node:http` rather than `fetch`, because this client runs in BOTH runtimes.
 * Bun's fetch takes a `unix` option and Node's does not — it ignores the
 * field, sends the request to `http://localhost/` over TCP, and fails. So the
 * VS Code extension host reported "no daemon listening" while a daemon was
 * running and answering perfectly on the same machine, which is exactly the
 * kind of failure a silently-ignored option produces.
 *
 * `node:http` supports unix sockets natively in both, so one code path serves
 * both hosts rather than a runtime check choosing between two.
 */
function post(socketPath: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath: socketPath,
                path: "/",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
            },
            response => {
                let text = ""
                response.setEncoding("utf-8")
                response.on("data", chunk => { text += chunk })
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }))
            },
        )
        request.on("error", reject)
        request.end(body)
    })
}

export type CallerT = ReturnType<typeof Caller>

/**
 * A `fetch` over the daemon's socket — what a client hands
 * `AxonCloud().agents.attach()` to reach an agent through the daemon.
 *
 * The URL's host is ignored; its path and query go to the socket as they are.
 * The answer streams: an event stream from an agent on another machine stays
 * open and flows for as long as the agent holds it. `node:http`, not `fetch`,
 * for the same reason as `post()` — Node's fetch cannot reach a unix socket.
 */
export function socketFetch(opts: { paths: DaemonPaths }): typeof fetch {
    async function socketed(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const request = input instanceof Request ? new Request(input, init) : new Request(input instanceof URL ? input.href : input, init)
        const url = new URL(request.url)
        const body = request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer())
        const headers: Record<string, string> = {}
        request.headers.forEach((value, name) => { headers[name] = value })
        if (body !== null) headers["content-length"] = String(body.length)

        return new Promise((resolve, reject) => {
            const outgoing = httpRequest(
                { socketPath: opts.paths.socket, path: `${url.pathname}${url.search}`, method: request.method, headers: headers },
                incoming => {
                    const answer = new Headers()
                    for (const [name, value] of Object.entries(incoming.headers)) {
                        if (value !== undefined) answer.set(name, Array.isArray(value) ? value.join(", ") : value)
                    }
                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            incoming.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
                            incoming.on("end", () => controller.close())
                            incoming.on("error", cause => controller.error(cause))
                        },
                        cancel() { incoming.destroy() },
                    })
                    resolve(new Response(stream, { status: incoming.statusCode ?? 0, headers: answer }))
                },
            )
            request.signal.addEventListener("abort", () => outgoing.destroy(new Error("aborted")))
            outgoing.on("error", cause => reject(err("DAEMON_NOT_RUNNING", {
                detail: `no daemon listening on ${opts.paths.socket}`,
                context: { socket: opts.paths.socket, path: url.pathname },
                cause: cause,
            })))
            outgoing.end(body ?? undefined)
        })
    }
    return socketed as typeof fetch
}
