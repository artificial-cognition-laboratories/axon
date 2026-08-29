import { err } from "@arcforge/err"
import { randomBytes } from "node:crypto"
import { Dispatch, type DispatchT } from "./dispatch"
import { isControlFrame, type ControlHello, type EditorSurface } from "./protocol"

/**
 * ControlServer — the TUI end of the control channel.
 *
 * Listens on an ephemeral port and mints a token, both of which the caller
 * writes into its `AxonInstance` record. That record is the discovery
 * mechanism: `Running()` already scans it, pid-checks it, GCs it and
 * watches it, so the channel inherits liveness for free and needs no
 * announce protocol of its own. The port dies with the process, which is
 * exactly the fact the pid check already proves — so publishing it does not
 * weaken the registry's invariant that every field is either true for the
 * life of the process or absent.
 *
 * Auth is a token rather than file permissions because a listening port is
 * reachable by any local process regardless of how the store is chmod'd.
 * The 0700 store guards the secret; the token guards the socket.
 *
 * MANY editors may attach at once, and that is load-bearing rather than
 * incidental. A user with two windows open has two valid targets for
 * "open this session log", and they are not interchangeable — each has
 * different folders open, so only one can act meaningfully on a given
 * path. Holding one connection would force the TUI to guess; holding all
 * of them lets it ASK (`editor.claim`) and route to the best answer.
 *
 * A peer that dies takes its own entry with it: the socket close handler
 * is the only thing that removes one, so there is no liveness bookkeeping
 * beyond what the transport already proves.
 */
export function ControlServer(opts: { handle: unknown; port?: number }) {
    const token = randomBytes(32).toString("hex")

    let server: ReturnType<typeof Bun.serve> | null = null

    /**
     * Membership listeners. A UI that gates on "is an editor attached" needs to
     * re-render when that flips, and polling `peerCount` would mean either a
     * timer or a missed change — the socket already knows the exact moment.
     */
    const watchers = new Set<(count: number) => void>()
    function announce(): void {
        for (const watcher of watchers) watcher(peers.size)
    }

    /**
     * Every attached editor, keyed by its socket. One dispatcher each —
     * ids are per-connection, so two windows' calls can never collide.
     */
    type Peer = { socket: { send(data: string): void; close(): void }; dispatch: DispatchT }
    const peers = new Map<unknown, Peer>()

    function drop(key: unknown, cause: string): void {
        const found = peers.get(key)
        if (!found) return
        found.dispatch.close(cause)
        peers.delete(key)
        announce()
    }

    /**
     * The editor to send to. One attached peer is not a choice; several
     * are polled and ranked.
     *
     * A peer that fails to answer is dropped from the running rather than
     * failing the whole call — an editor mid-reload should not stop a
     * healthy window from receiving the message.
     */
    async function pick(path?: string): Promise<DispatchT> {
        const attached = [...peers.values()]
        if (attached.length === 0) {
            throw err("CONTROL_CLOSED", { detail: "no editor attached" })
        }
        if (attached.length === 1) return attached[0]!.dispatch

        const ranked = await Promise.all(attached.map(async peer => {
            try {
                const claim = await peer.dispatch.call(["editor", "claim"], [path ?? null]) as {
                    contains?: boolean
                    focusedAt?: number
                }
                return { dispatch: peer.dispatch, contains: claim?.contains === true, focusedAt: claim?.focusedAt ?? 0 }
            } catch {
                return { dispatch: peer.dispatch, contains: false, focusedAt: 0 }
            }
        }))

        // Containment first — it is the difference between useful and
        // useless — then recency of focus.
        ranked.sort((left, right) =>
            left.contains !== right.contains ? (left.contains ? -1 : 1) : right.focusedAt - left.focusedAt,
        )
        return ranked[0]!.dispatch
    }

    return {
        token,

        /** The bound port. Null until listen() has run. */
        get port(): number | null {
            return server?.port ?? null
        },

        /** True while at least one editor is attached. */
        get attached(): boolean {
            return peers.size > 0
        },

        /** How many editors are attached — the count the TUI polls across. */
        get peerCount(): number {
            return peers.size
        },

        /**
         * Observe attach/detach. Fires with the new count on every membership
         * change; returns a teardown. Exists so a UI can GATE on whether an
         * editor is reachable — a button that cannot route should not be
         * rendered, and finding that out by polling would either burn a timer
         * or miss the change the socket already knows about exactly.
         */
        watch(listener: (count: number) => void): () => void {
            watchers.add(listener)
            return () => { watchers.delete(listener) }
        },

        /**
         * Start listening. Returns the bound port so the caller can put it
         * on the instance record. Binds to loopback only — this channel is
         * local by definition and must never be reachable off-box.
         */
        listen(): number {
            if (server) return server.port!

            server = Bun.serve({
                port: opts.port ?? 0,
                hostname: "127.0.0.1",
                // An upgraded request must return nothing — Bun's own types
                // model that as `undefined` on a union this overload can't
                // narrow to, so the cast is at the framework seam, not over
                // a shape of ours.
                fetch(request, self): Response {
                    if (self.upgrade(request, { data: null })) return undefined as unknown as Response
                    return new Response("axon control channel", { status: 426 })
                },
                websocket: {
                    message(ws, raw) {
                        let frame: unknown
                        try {
                            frame = JSON.parse(String(raw))
                        } catch {
                            // Unparseable bytes on a local socket mean the
                            // peer is not who it claims to be. Close rather
                            // than continue reading.
                            ws.close(1003, "malformed frame")
                            return
                        }

                        // Handshake first: nothing is served before a valid
                        // token, so an unauthorised connection can never
                        // reach the handle.
                        const known = peers.get(ws)
                        if (!known) {
                            const hello = frame as ControlHello
                            if (hello?.type !== "control.hello" || hello.token !== token) {
                                ws.close(1008, "unauthorized")
                                return
                            }
                            const socket = { send: (data: string) => ws.send(data), close: () => ws.close() }
                            peers.set(ws, {
                                socket,
                                dispatch: Dispatch({ handle: opts.handle, send: f => socket.send(JSON.stringify(f)) }),
                            })
                            ws.send(JSON.stringify({ type: "control.welcome", peer: "tui" }))
                            announce()
                            return
                        }

                        if (!isControlFrame(frame)) return
                        known.dispatch.accept(frame)
                    },
                    close(ws) {
                        drop(ws, "editor disconnected")
                    },
                },
            })

            return server.port!
        },

        /**
         * Call one editor — the best target for `about`, when given.
         *
         * Windows are not interchangeable: each has different folders open,
         * so "open this session log" is useful in the window whose
         * workspace contains the path and useless in the one that does not.
         * Rather than guess, every attached editor is asked `claim(path)`
         * and the best answer wins — a window that contains the path beats
         * one that does not, and focus breaks the tie.
         *
         * Without `about` the call goes to the most recently focused
         * editor, which is the right default for anything not about a
         * particular file.
         *
         * Rejects when nobody is attached rather than resolving quietly:
         * "the panel did not focus because nothing is listening" is
         * information the caller needs, not a no-op.
         */
        editor: {
            async call<K extends keyof EditorSurface>(
                method: K,
                ...args: Parameters<EditorSurface[K]>
            ): Promise<Awaited<ReturnType<EditorSurface[K]>>> {
                const target = await pick()
                return (await target.call(["editor", String(method)], args)) as Awaited<ReturnType<EditorSurface[K]>>
            },

            /** As `call`, but routed to whichever window can act on `path`. */
            async about<K extends keyof EditorSurface>(
                path: string,
                method: K,
                ...args: Parameters<EditorSurface[K]>
            ): Promise<Awaited<ReturnType<EditorSurface[K]>>> {
                const target = await pick(path)
                return (await target.call(["editor", String(method)], args)) as Awaited<ReturnType<EditorSurface[K]>>
            },
        },

        close(): void {
            for (const [key, peer] of peers) {
                drop(key, "tui shutting down")
                peer.socket.close()
            }
            server?.stop(true)
            server = null
        },
    }
}

export type ControlServerT = ReturnType<typeof ControlServer>
