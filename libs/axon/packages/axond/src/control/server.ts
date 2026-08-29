import { existsSync, rmSync } from "node:fs"
import { err } from "@arcforge/err"
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
    dispatch: (path: readonly string[], arg: unknown) => Promise<unknown>
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

            if (existsSync(opts.paths.socket)) rmSync(opts.paths.socket, { force: true })

            try {
                server = Bun.serve({
                    unix: opts.paths.socket,
                    fetch: async request => {
                        const body = (await request.json()) as { path?: unknown; arg?: unknown }
                        if (!Array.isArray(body.path)) {
                            return Response.json({ ok: false, error: "malformed request: path must be an array" }, { status: 400 })
                        }

                        try {
                            const value = await opts.dispatch(body.path as string[], body.arg)
                            return Response.json({ ok: true, value: value })
                        } catch (cause) {
                            // Reported, never swallowed: a client that got a
                            // 200 with no value could not tell a verb that
                            // returned nothing from one that threw.
                            return Response.json(
                                { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
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
