import { connect } from "node:net"
import { err } from "@arcforge/err"
import { rebuild } from "../control/index"

export type Path = "direct" | "relay"

/** This machine on the network, as its sidecar reports it. */
export type NetStatus = {
    /** The machine's public key — its address on the network. */
    id: string
    /** Direct addresses another machine may dial. */
    addrs: string[]
    /** Whether it is reachable through a relay too. */
    relay: boolean
}

/** Another machine: its key, and direct addresses to try first. */
export type Peer = { key: string; addrs?: string[] }

const SIDECAR_CODES = ["NET_UNREACHABLE", "NET_PROTOCOL"] as const

/**
 * NetSocket — the daemon's side of `net.sock`.
 *
 * One connection per question: a header line, the sidecar's one-line answer,
 * then — for a request — the stream to the other machine, carrying one
 * `{ path, arg }` out and one `{ ok, value | fault }` back. A remote fault is
 * rebuilt into the error its domain threw, exactly as the local socket does.
 */
export function NetSocket(opts: { path: string }) {
    return {
        async status(): Promise<NetStatus> {
            const { head } = await exchange(opts.path, { status: true }, null)
            return head as NetStatus
        },

        /** Call one verb on another machine. */
        async request(peer: Peer, body: { path: readonly string[]; arg?: unknown }): Promise<{ value: unknown; path: Path }> {
            const { head, rest } = await exchange(opts.path, { dial: peer.key, addrs: peer.addrs ?? [] }, JSON.stringify(body))
            const dialed = head as { ok: boolean; path?: Path; fault?: { code?: string; message?: string } }
            if (!dialed.ok) {
                const code = SIDECAR_CODES.find(known => known === dialed.fault?.code) ?? "NET_PROTOCOL"
                throw err(code, { detail: dialed.fault?.message ?? "the sidecar refused without saying why", context: { peer: peer.key } })
            }
            if (rest.trim() === "") {
                throw err("NET_UNREACHABLE", {
                    detail: `${peer.key.slice(0, 10)}… answered the connection but its daemon did not answer the request`,
                    context: { peer: peer.key, verb: body.path.join(".") },
                })
            }
            const answer = parse(rest) as { ok: boolean; value?: unknown; error?: string; fault?: { code?: string; message?: string; context?: unknown } }
            if (!answer.ok) throw rebuild(body.path, answer)
            return { value: answer.value, path: dialed.path ?? "direct" }
        },

        /**
         * One HTTP request to an agent's surface on another machine. The
         * answer's body streams from the network as it arrives — an event
         * stream stays open for as long as the far side holds it.
         */
        fetch(peer: Peer, request: { session: string; method: string; path: string; headers: Record<string, string>; body: string | null }): Promise<Response> {
            return streamed(opts.path, peer, request)
        },
    }
}

export type NetSocketT = ReturnType<typeof NetSocket>

/**
 * One connection: write the header (and a body, then half-close), read the
 * sidecar's first line and everything after it. A socket nobody is listening
 * on is the sidecar being down, said as such.
 */
function exchange(path: string, header: unknown, body: string | null): Promise<{ head: unknown; rest: string }> {
    return new Promise((resolve, reject) => {
        const socket = connect(path)
        let text = ""
        socket.setEncoding("utf-8")
        socket.on("connect", () => {
            socket.write(`${JSON.stringify(header)}\n`)
            if (body !== null) socket.write(body)
            socket.end()
        })
        socket.on("data", chunk => { text += chunk })
        socket.on("error", cause => reject(err("NET_SIDECAR_DOWN", { detail: `nothing listening on ${path}`, context: { socket: path }, cause: cause })))
        socket.on("end", () => {
            const newline = text.indexOf("\n")
            if (newline === -1) {
                reject(err("NET_PROTOCOL", { detail: "the sidecar closed without answering", context: { socket: path } }))
                return
            }
            try {
                resolve({ head: parse(text.slice(0, newline)), rest: text.slice(newline + 1) })
            } catch (cause) {
                reject(cause)
            }
        })
    })
}

function parse(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (cause) {
        throw err("NET_PROTOCOL", { detail: `unreadable message: ${text.slice(0, 120)}`, cause: cause })
    }
}

/**
 * An HTTP exchange over the network, answered as a web `Response`.
 *
 * Two lines precede the body: the sidecar's dial answer, then the far daemon's
 * head (`{ ok, http: { status, headers } }`) or its fault. Everything after is
 * the agent's body, passed through unparsed. The stream ends when the far side
 * ends it; cancelling the body closes the connection.
 */
function streamed(path: string, peer: Peer, request: { session: string; method: string; path: string; headers: Record<string, string>; body: string | null }): Promise<Response> {
    return new Promise((resolve, reject) => {
        const socket = connect(path)
        const lines: string[] = []
        let pending = Buffer.alloc(0)
        let body: ReadableStreamDefaultController<Uint8Array> | null = null

        function settle(head: { ok?: boolean; http?: { status: number; headers: Record<string, string> }; error?: string; fault?: { code?: string; message?: string; context?: unknown } }, rest: Buffer): void {
            if (!head.ok || head.http === undefined) {
                socket.destroy()
                reject(rebuild(["agents", request.session, request.path], head))
                return
            }
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    body = controller
                    if (rest.length > 0) controller.enqueue(new Uint8Array(rest))
                },
                cancel() { socket.destroy() },
            })
            resolve(new Response(stream, { status: head.http.status, headers: head.http.headers }))
        }

        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ dial: peer.key, addrs: peer.addrs ?? [] })}\n`)
            const { body: payload, ...head } = request
            socket.write(`${JSON.stringify({ http: head })}\n`)
            if (payload !== null) socket.write(payload)
            socket.end()
        })
        socket.on("data", (chunk: Buffer) => {
            if (body !== null) {
                body.enqueue(new Uint8Array(chunk))
                return
            }
            pending = Buffer.concat([pending, chunk])
            let newline: number
            while (lines.length < 2 && (newline = pending.indexOf(10)) !== -1) {
                lines.push(pending.subarray(0, newline).toString("utf-8"))
                pending = pending.subarray(newline + 1)
            }
            if (lines.length === 0) return
            try {
                const dialed = parse(lines[0]!) as { ok: boolean; fault?: { code?: string; message?: string } }
                if (!dialed.ok) {
                    const code = SIDECAR_CODES.find(known => known === dialed.fault?.code) ?? "NET_PROTOCOL"
                    socket.destroy()
                    reject(err(code, { detail: dialed.fault?.message ?? "the sidecar refused without saying why", context: { peer: peer.key } }))
                    return
                }
                if (lines.length === 2) settle(parse(lines[1]!) as Parameters<typeof settle>[0], pending)
            } catch (cause) {
                socket.destroy()
                reject(cause)
            }
        })
        socket.on("end", () => {
            if (body !== null) body.close()
            else if (lines.length < 2) reject(err("NET_UNREACHABLE", { detail: `${peer.key.slice(0, 10)}… answered the connection but its daemon did not answer the request`, context: { peer: peer.key } }))
        })
        socket.on("error", cause => {
            if (body !== null) body.error(cause)
            else reject(err("NET_SIDECAR_DOWN", { detail: `nothing listening on ${path}`, context: { socket: path }, cause: cause }))
        })
    })
}
