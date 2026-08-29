import { err } from "@arcforge/err"
import type { ControlFrame, RpcCall, RpcPath, RpcResult, RpcSubscribe, RpcUnsubscribe } from "./protocol"

type Send = (frame: ControlFrame) => void

/** Walk a property path off root, throwing with the path spelled out if any segment is missing. */
function resolve(root: unknown, path: RpcPath): unknown {
    let target: unknown = root
    for (const key of path) {
        if (target === null || typeof target !== "object" || !(key in target)) {
            throw err("CONTROL_PATH_NOT_FOUND", { detail: `no such method on the peer: ${path.join(".")}`, context: { path: path.join(".") } })
        }
        target = (target as Record<string, unknown>)[key]
    }
    return target
}

/**
 * Dispatch — one end of the control channel.
 *
 * Symmetric by construction: it serves inbound calls against a local
 * handle AND issues outbound calls to the peer, because both ends do both.
 * The TUI driving the editor and the editor driving the TUI are one
 * implementation used twice, not two features.
 *
 * Holds the channel's only state — pending outbound calls and live inbound
 * subscriptions — so that `close()` can settle every promise a caller is
 * still awaiting. A peer that vanishes mid-call must reject, never hang:
 * this is a cross-process socket, and the caller has no other way to learn
 * the TUI just died.
 */
export function Dispatch(opts: { handle: unknown; send: Send }) {
    /** Outbound: calls we are awaiting an answer to. */
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: unknown) => void }>()
    /** Inbound: subscriptions the peer opened against our handle. */
    const serving = new Map<string, () => void>()
    /** Outbound: listeners we registered on the peer. */
    const listening = new Map<string, (value: unknown) => void>()

    let closed = false
    let counter = 0
    const nextId = (): string => `${++counter}`

    /**
     * Serve one inbound call. Never throws outward — a failure becomes an
     * ok:false result, because the peer is across a socket and has no stack
     * to catch into. The CALLER is responsible for checking `ok`; see
     * `call()`, which rejects rather than returning a falsy value, so a
     * failure cannot be mistaken for a result.
     */
    async function serveCall(frame: RpcCall): Promise<void> {
        try {
            const parent = resolve(opts.handle, frame.path.slice(0, -1))
            const method = resolve(opts.handle, frame.path)
            if (typeof method !== "function") throw err("CONTROL_PATH_NOT_CALLABLE", { detail: `not callable on the peer: ${frame.path.join(".")}`, context: { path: frame.path.join(".") } })
            const value = await (method as (...args: unknown[]) => unknown).apply(parent, frame.args)
            opts.send({ type: "rpc.result", id: frame.id, ok: true, value })
        } catch (cause) {
            opts.send({
                type: "rpc.result",
                id: frame.id,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
            })
        }
    }

    /** Serve one inbound subscribe, adapting the local `.watch()` into rpc.event frames. */
    function serveSubscribe(frame: RpcSubscribe): void {
        try {
            const parent = resolve(opts.handle, frame.path.slice(0, -1))
            const method = resolve(opts.handle, frame.path)
            if (typeof method !== "function") throw err("CONTROL_PATH_NOT_CALLABLE", { detail: `not callable on the peer: ${frame.path.join(".")}`, context: { path: frame.path.join(".") } })
            const listener = (value: unknown) => opts.send({ type: "rpc.event", id: frame.id, value })
            const teardown = (method as (...args: unknown[]) => () => void).apply(parent, [...frame.args, listener])
            serving.set(frame.id, teardown)
        } catch (cause) {
            // A subscription that failed to start still owes the caller an
            // answer — otherwise it waits forever on a stream that will
            // never produce a frame.
            opts.send({
                type: "rpc.result",
                id: frame.id,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
            })
        }
    }

    function serveUnsubscribe(frame: RpcUnsubscribe): void {
        serving.get(frame.id)?.()
        serving.delete(frame.id)
    }

    function settle(frame: RpcResult): void {
        const waiter = pending.get(frame.id)
        if (!waiter) return
        pending.delete(frame.id)
        if (frame.ok) waiter.resolve(frame.value)
        else waiter.reject(err("CONTROL_CALL_FAILED", { detail: frame.error, context: { error: frame.error } }))
    }

    return {
        /** Feed one decoded frame in. The transport owns bytes; this owns meaning. */
        accept(frame: ControlFrame): void {
            if (frame.type === "rpc.call") return void serveCall(frame)
            if (frame.type === "rpc.subscribe") return serveSubscribe(frame)
            if (frame.type === "rpc.unsubscribe") return serveUnsubscribe(frame)
            if (frame.type === "rpc.result") return settle(frame)
            listening.get(frame.id)?.(frame.value)
        },

        /**
         * Call a method on the PEER's handle. Rejects on failure — a remote
         * error is an error here, so `await peer.call(...)` fails loudly at
         * the call site instead of quietly returning undefined.
         */
        call(path: RpcPath, args: unknown[] = []): Promise<unknown> {
            if (closed) return Promise.reject(err("CONTROL_CLOSED", { detail: `channel closed before ${path.join(".")} could be sent`, context: { path: path.join(".") } }))
            const id = nextId()
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject })
                opts.send({ type: "rpc.call", id, path, args })
            })
        },

        /** Subscribe to a stream on the peer's handle. Returns the teardown. */
        subscribe(path: RpcPath, args: unknown[], listener: (value: unknown) => void): () => void {
            if (closed) throw err("CONTROL_CLOSED", { detail: `channel closed before ${path.join(".")} could be sent`, context: { path: path.join(".") } })
            const id = nextId()
            listening.set(id, listener)
            opts.send({ type: "rpc.subscribe", id, path, args })
            return () => {
                if (!listening.delete(id)) return
                if (!closed) opts.send({ type: "rpc.unsubscribe", id })
            }
        },

        /**
         * Tear down both directions. Every in-flight outbound call rejects:
         * the peer is gone and no answer is coming, so leaving those
         * promises pending would hang the caller forever.
         */
        close(cause: string): void {
            if (closed) return
            closed = true
            for (const teardown of serving.values()) teardown()
            serving.clear()
            listening.clear()
            for (const waiter of pending.values()) waiter.reject(err("CONTROL_CLOSED", { detail: cause, context: { error: cause } }))
            pending.clear()
        },
    }
}

export type DispatchT = ReturnType<typeof Dispatch>
