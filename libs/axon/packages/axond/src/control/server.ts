import { Stream } from "./stream"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { connect } from "node:net"
import { err, isAxonError } from "@arcforge/err"
import type { DaemonPaths } from "../../types/index"

type ServerOpts = {
    paths: DaemonPaths
    /**
     * Resolve one verb path against the daemon's domains.
     *
     * A FUNCTION rather than the root itself: the server's job is bytes in,
     * bytes out, and handing it `Axond()` would make it able to reach past the
     * dispatch it is supposed to be. It knows a path and an argument; what
     * those mean is the root's business.
     */
    dispatch: (path: readonly string[], arg: unknown, signal?: AbortSignal) => Promise<unknown>
    /**
     * Requests addressed to an agent on another machine, carried there as
     * HTTP. Null for anything else, which is then a verb call.
     */
    tunnel: (request: Request) => Promise<Response | null>
}

/**
 * Server — the daemon's unix socket.
 *
 * ── Why a socket and not a port ─────────────────────────────────────────────
 *
 * Filesystem permissions ARE the access control. The daemon holds a cloud
 * session and mediates the GPU; a TCP port is reachable by anything on the
 * host, while a `0o700` socket under the user's own `~/.axon` is reachable by
 * that user. Same reasoning the supervisor link already applies.
 *
 * ── A stale socket is cleared, never worked around ──────────────────────────
 *
 * A process killed with -9 leaves a socket file that `listen` refuses with
 * EADDRINUSE even though nothing is behind it. The lifecycle has already
 * established no live pid holds it by the time this runs, so removing it is
 * correct rather than hopeful — and doing it here means `up` never has to
 * carry a retry.
 */
export function Server(opts: ServerOpts) {
    let server: ReturnType<typeof Bun.serve> | null = null

    return {
        /** Whether ANY process is accepting on the socket. A refused or missing socket is no. */
        answering(): Promise<boolean> {
            if (!existsSync(opts.paths.socket)) return Promise.resolve(false)
            return new Promise(resolve => {
                const probe = connect(opts.paths.socket)
                probe.once("connect", () => { probe.destroy(); resolve(true) })
                probe.once("error", () => resolve(false))
            })
        },

        /** Whether this process is currently listening. */
        get listening(): boolean {
            return server !== null
        },

        /**
         * Bind the socket. Throws if it cannot.
         *
         * The caller has already checked no daemon is running — this refuses
         * loudly rather than assuming, because binding a socket a live daemon
         * owns would give one machine two things that each believe they own
         * the GPU.
         */
        listen(): void {
            if (server !== null) {
                throw err("DAEMON_ALREADY_RUNNING", { detail: `already listening on ${opts.paths.socket}` })
            }

            /**
             * The socket's directory, before binding into it.
             *
             * `Lifecycle` also creates this, but it does so when it CLAIMS the
             * pidfile — which `serve()` does after the socket binds, so that a
             * live pid always implies a listening socket. On a machine with no
             * `~/.axon` yet, that ordering meant the very first `daemon up`
             * died with `ENOENT: listen`: the first user action on a fresh
             * install was the one that could not work.
             */
            mkdirSync(dirname(opts.paths.socket), { recursive: true })

            if (existsSync(opts.paths.socket)) rmSync(opts.paths.socket, { force: true })

            try {
                server = Bun.serve({
                    unix: opts.paths.socket,
                    // Model loading and prompt evaluation can be silent for minutes.
                    // The inference signal and client disconnect own cancellation.
                    idleTimeout: 0,
                    fetch: async request => {
                        try {
                            const tunnelled = await opts.tunnel(request)
                            if (tunnelled !== null) return tunnelled
                            const body = (await request.json()) as { path?: unknown; arg?: unknown }
                            if (!body || !Array.isArray(body.path)) return Response.json({ ok: false, error: "malformed request: path must be an array" }, { status: 400 })
                            if (!body.path.every(segment => typeof segment === "string")) throw new Error("invalid verb path")
                            const controller = new AbortController()
                            const value = await opts.dispatch(body.path, body.arg, controller.signal)
                            if (isStream(value)) {
                                return Stream({ iterator: value, controller: controller }).response()
                            }
                            return Response.json({ ok: true, value: value })
                        } catch (cause) {
                            /*
                             * Reported, never swallowed: a client that got a
                             * 200 with no value could not tell a verb that
                             * returned nothing from one that threw.
                             *
                             * The whole error crosses, not just its message.
                             * Sending `cause.message` alone discarded the CODE,
                             * so every failure — a job refused because a person
                             * has to take it, a weight that is not cached, a
                             * model that will not fit — reached the client as
                             * one generic error. Dispatch's contract is that a
                             * caller "sees exactly the code a local caller
                             * would, and the wire adds nothing to it"; a
                             * flattened message is the wire adding a lie.
                             *
                             * `error` stays a string for anything that is not
                             * an AxonError, because a thrown non-Error has no
                             * code to preserve.
                             */
                            const fault = isAxonError(cause) ? cause.toJSON() : null
                            return Response.json(
                                {
                                    ok: false,
                                    error: fault ? fault.message : (cause instanceof Error ? cause.message : String(cause)),
                                    ...(fault ? { fault: fault } : {}),
                                },
                                { status: 500 },
                            )
                        }
                    },
                })
            } catch (cause) {
                throw err("DAEMON_SOCKET_UNAVAILABLE", {
                    detail: `${opts.paths.socket} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { socket: opts.paths.socket },
                    cause,
                })
            }
        },

        /** Stop listening and unlink the socket, so the next start binds cleanly. */
        async close(): Promise<void> {
            if (server === null) return
            await server.stop(true)
            server = null
            rmSync(opts.paths.socket, { force: true })
        },
    }
}

export type ServerT = ReturnType<typeof Server>

function isStream(value: unknown): value is AsyncIterable<unknown> {
    return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"
}

// Bun supports idleTimeout for Unix sockets, but bun-types exposes it only
// on TCP options. The real Unix stream regression verifies this boundary.
declare module "bun" {
    namespace Serve {
        interface UnixServeOptions<WebSocketData> {
            idleTimeout?: number
        }
    }
}
