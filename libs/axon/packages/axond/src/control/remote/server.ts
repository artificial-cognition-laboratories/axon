import { createServer, type Server as NodeServer, type Socket } from "node:net"
import { chmodSync, existsSync, rmSync } from "node:fs"
import { err, isAxonError } from "@arcforge/err"
import { Dispatch } from "../dispatch"
import type { AttachRequest } from "./attach"
import type { RemoteT } from "./remote"
import type { Peer } from "./types"

type RemoteServerOpts = {
    /** The daemon's `remote.sock` — the sidecar connects here once per inbound stream. */
    socket: string
    /**
     * Who a verified key belongs to, as a peer of this machine — or a refusal.
     *
     * The directory's answer: the key must be a machine of the same account and
     * must not have been removed. Throws NET_REFUSED otherwise. The handshake
     * proved WHICH machine is calling; this decides whether it may.
     */
    authorize: (key: string) => Promise<Peer>
    /** The remote surface, built for one authorized peer. */
    surface: (peer: Peer) => RemoteT
    /** An authorized peer's HTTP request for one agent's `/_axon/*` surface. */
    attach: (peer: Peer, request: AttachRequest) => Promise<Response>
}

/**
 * RemoteServer — requests from other machines, answered.
 *
 * Every inbound stream arrives from the sidecar as a header naming the caller's
 * verified key, then one `{ path, arg }`. Before anything is dispatched the
 * caller is authorized; then the verb is resolved against `Remote` for that
 * peer — never the local domains — so only what `Remote` names is reachable.
 * The answer is `{ ok, value | fault }`, the fault carrying its code across.
 */
export function RemoteServer(opts: RemoteServerOpts) {
    let server: NodeServer | null = null

    /**
     * One inbound stream: the sidecar's header naming the verified caller,
     * then either a verb (`{ path, arg }`) or an HTTP request for one agent's
     * surface (`{ http }` on its own line, then the body). The caller is
     * authorized before either is looked at.
     */
    async function answer(raw: string): Promise<{ value: unknown } | { response: Response }> {
        const newline = raw.indexOf("\n")
        if (newline === -1) throw err("NET_PROTOCOL", { detail: "an inbound stream carried no header" })
        const header = parse(raw.slice(0, newline)) as { from?: unknown }
        if (typeof header.from !== "string") throw err("NET_PROTOCOL", { detail: "an inbound header named no caller" })
        const peer = await opts.authorize(header.from)

        const rest = raw.slice(newline + 1)
        const line = rest.indexOf("\n")
        const first = line === -1 ? rest : rest.slice(0, line)
        if (first.startsWith(`{"http":`)) {
            const head = (parse(first) as { http: Omit<AttachRequest, "body"> }).http
            return { response: await opts.attach(peer, { ...head, body: line === -1 ? null : rest.slice(line + 1) }) }
        }

        const request = parse(rest) as { path?: unknown; arg?: unknown }
        if (!Array.isArray(request.path) || !request.path.every(segment => typeof segment === "string")) {
            throw err("NET_PROTOCOL", { detail: "an inbound request's path is not a list of names" })
        }
        const dispatch = Dispatch({ domains: opts.surface(peer) })
        return { value: await dispatch(request.path, request.arg) }
    }

    function serve(socket: Socket): void {
        let raw = ""
        socket.setEncoding("utf-8")
        socket.on("data", chunk => { raw += chunk })
        socket.on("end", () => {
            answer(raw).then(
                async answered => {
                    if ("response" in answered) await stream(socket, answered.response)
                    else socket.end(`${JSON.stringify({ ok: true, value: answered.value })}\n`)
                },
                cause => {
                    const fault = isAxonError(cause) ? cause.toJSON() : null
                    // A terminated line, like every head on this stream: a caller
                    // reading an HTTP answer waits for the line before the body.
                    socket.end(`${JSON.stringify({
                        ok: false,
                        error: fault ? fault.message : (cause instanceof Error ? cause.message : String(cause)),
                        ...(fault ? { fault: fault } : {}),
                    })}\n`)
                },
            ).catch(cause => socket.destroy(cause instanceof Error ? cause : new Error(String(cause))))
        })
    }

    return {
        /** Bind `remote.sock`, `0600`. A stale file from a killed daemon is removed first. */
        listen(): Promise<void> {
            if (existsSync(opts.socket)) rmSync(opts.socket, { force: true })
            const bound = createServer({ allowHalfOpen: true }, serve)
            server = bound
            return new Promise((resolve, reject) => {
                bound.once("error", reject)
                bound.listen(opts.socket, () => {
                    chmodSync(opts.socket, 0o600)
                    resolve()
                })
            })
        },
        async close(): Promise<void> {
            const bound = server
            server = null
            if (bound === null) return
            await new Promise<void>(resolve => bound.close(() => resolve()))
            rmSync(opts.socket, { force: true })
        },
    }
}

export type RemoteServerT = ReturnType<typeof RemoteServer>

function parse(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (cause) {
        throw err("NET_PROTOCOL", { detail: `an inbound message was not JSON: ${text.slice(0, 120)}`, cause: cause })
    }
}

/**
 * An agent's HTTP answer, onto the stream: a head line, then the body as it
 * arrives — an event stream is held open and flows, never buffered whole.
 * Writes wait on the socket when it is full, so a slow reader slows the agent's
 * stream rather than growing this process's memory.
 */
async function stream(socket: Socket, response: Response): Promise<void> {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => { headers[name] = value })
    socket.write(`${JSON.stringify({ ok: true, http: { status: response.status, headers: headers } })}\n`)
    if (response.body !== null) {
        const reader = response.body.getReader()
        socket.on("close", () => { void reader.cancel() })
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!socket.write(value)) await new Promise<void>(resolve => socket.once("drain", () => resolve()))
        }
    }
    socket.end()
}
