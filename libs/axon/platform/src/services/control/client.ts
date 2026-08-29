import { err } from "@arcforge/err"
import type { AxonInstance } from "@arcforge/types"
import { Dispatch, type DispatchT } from "./dispatch"
import { isControlFrame, type TuiSurface } from "./protocol"

/**
 * ControlClient — the editor end of the control channel.
 *
 * Dials a running TUI using the port and token on its instance record.
 * There is no discovery here on purpose: `Running()` already answers "what
 * is running right now", and the extension already watches it. This turns
 * one record into one connection, nothing more.
 *
 * Uses the global `WebSocket` present in both Node 18+ (the extension host)
 * and Bun (the TUI), so the same module serves both ends without a `ws`
 * dependency in either.
 *
 * Reconnection is deliberately NOT here. A TUI that exits has its record
 * deleted by the registry's own GC, and the extension's existing
 * `fleet.watch()` fires — so "reattach when it comes back" is a
 * consequence of watching the registry, not a timer this client owns.
 * Adding backoff here would create a second liveness mechanism competing
 * with the one that already works.
 */
export function ControlClient(opts: { handle: unknown }) {
    let socket: WebSocket | null = null
    let dispatch: DispatchT | null = null
    let sessionId: string | null = null

    return {
        /** The session id this client is attached to, or null. */
        get attached(): string | null {
            return sessionId
        },

        /**
         * Connect to one running instance. Resolves once the TUI has
         * accepted the handshake — so a caller that awaits this knows the
         * channel is live, and a rejected token fails here rather than on
         * the first call.
         */
        connect(instance: AxonInstance): Promise<void> {
            if (!instance.control) {
                throw err("CONTROL_CLOSED", { detail: `${instance.sessionId} exposes no control channel`, context: { sessionId: instance.sessionId } })
            }
            this.disconnect()

            const { port, token } = instance.control
            const ws = new WebSocket(`ws://127.0.0.1:${port}`)
            socket = ws

            return new Promise((resolve, reject) => {
                let welcomed = false

                ws.onopen = () => ws.send(JSON.stringify({ type: "control.hello", token, peer: "editor" }))

                ws.onmessage = event => {
                    let frame: unknown
                    try {
                        frame = JSON.parse(String(event.data))
                    } catch {
                        return
                    }

                    if (!welcomed) {
                        if ((frame as { type?: string }).type !== "control.welcome") return
                        welcomed = true
                        sessionId = instance.sessionId
                        dispatch = Dispatch({ handle: opts.handle, send: f => ws.send(JSON.stringify(f)) })
                        resolve()
                        return
                    }

                    if (!isControlFrame(frame)) return
                    dispatch?.accept(frame)
                }

                // A close before the welcome is a rejected handshake — the
                // TUI closes with 1008 on a bad token. Surfacing it here
                // means a version mismatch fails at connect, loudly, rather
                // than as a silent absence of a channel nobody notices.
                ws.onclose = event => {
                    dispatch?.close(`tui closed (${event.code})`)
                    dispatch = null
                    sessionId = null
                    socket = null
                    if (!welcomed) {
                        reject(
                            event.code === 1008
                                ? err("CONTROL_UNAUTHORIZED", { detail: `tui ${instance.sessionId} rejected the control token`, context: { sessionId: instance.sessionId } })
                                : err("CONTROL_CLOSED", { detail: `handshake failed (close ${event.code})`, context: { code: event.code } }),
                        )
                    }
                }

                ws.onerror = () => {
                    if (!welcomed) reject(err("CONTROL_CLOSED", { detail: `could not reach tui on port ${port}`, context: { port } }))
                }
            })
        },

        /**
         * Call the TUI. Rejects when nothing is attached — an editor
         * gesture that silently does nothing is worse than one that errors.
         */
        tui: {
            async call<K extends keyof TuiSurface>(
                method: K,
                ...args: Parameters<TuiSurface[K]>
            ): Promise<Awaited<ReturnType<TuiSurface[K]>>> {
                if (!dispatch) throw err("CONTROL_CLOSED", { detail: `no tui attached — cannot call ${String(method)}`, context: { method: String(method) } })
                return (await dispatch.call(["tui", String(method)], args)) as Awaited<ReturnType<TuiSurface[K]>>
            },
        },

        disconnect(): void {
            dispatch?.close("editor disconnecting")
            dispatch = null
            sessionId = null
            socket?.close()
            socket = null
        },
    }
}

export type ControlClientT = ReturnType<typeof ControlClient>
