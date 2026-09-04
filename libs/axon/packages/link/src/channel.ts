import { err } from "@arcforge/err"
import type { AxonEngineFault } from "@arcforge/types"
import { FrameReader, decodeMessage, encodeMessage } from "./frame"

/**
 * Channel — one socket, framed, with request/response correlation.
 *
 * Replaces the capsule's two `Host()` halves (host-side dispatcher, guest-side
 * correlated client) and their two pending maps with one thing that does the
 * job for both directions. Those halves also carried a bare `catch {}` around
 * the response send: a completed host call whose reply could not be delivered
 * vanished, and the guest's promise hung until its signal aborted. Here a
 * broken wire rejects every outstanding call by construction — see `fail()`.
 *
 * ── Message kinds ───────────────────────────────────────────────────────────
 *
 *   call    → request expecting exactly one reply
 *   reply   → that reply, ok or err
 *   send    → fire-and-forget, no reply, ordered (this is `commit`)
 *   open    → start a stream; many `chunk`s then one `end`
 *   chunk   → one element of a stream
 *   end     → stream terminator, ok or err
 *   abort   → cancel an in-flight call or stream
 *
 * Streams are first-class rather than emulated with repeated calls, because
 * `infer` is the hot path and the whole point of it crossing here is that the
 * consumer's pace reaches the producer. See `stream()`.
 */

type Wire =
    | { k: "call"; id: string; verb: string; arg: unknown }
    | { k: "reply"; id: string; ok: true; value: unknown }
    | { k: "reply"; id: string; ok: false; error: WireError }
    | { k: "send"; verb: string; arg: unknown }
    | { k: "open"; id: string; verb: string; arg: unknown }
    | { k: "chunk"; id: string; value: unknown }
    | { k: "end"; id: string; ok: true }
    | { k: "end"; id: string; ok: false; error: WireError }
    | { k: "abort"; id: string }

/**
 * Errors normally cross this boundary as a message only. Engine failures are
 * different: their retryability is part of the driver contract, so preserve
 * the already-serializable fault alongside the message.
 */
type WireError = { message: string; fault?: AxonEngineFault }

export type ChannelSocket = {
    /** Write bytes. The transport must not lose a short write — see Writer. */
    write(data: Uint8Array): number
    /**
     * Bytes accepted by the transport but not yet handed to the kernel.
     *
     * This is how backpressure becomes OBSERVABLE. A queueing writer cannot
     * refuse bytes without losing them, so it absorbs them — which turns a
     * slow consumer into unbounded memory growth instead of a stalled
     * producer. Exposing the depth lets a producer wait for it to fall,
     * which is what actually reaches back to the thing generating tokens.
     */
    readonly pending?: number
    /** Resolves once `pending` has fallen below the given depth. */
    whenDrained?(below: number): Promise<void>
    /** Best-effort close. */
    close(): void
}

/**
 * How much unsent data may pile up before a stream producer is made to wait.
 *
 * Generous enough that ordinary chunk-by-chunk streaming never pauses, small
 * enough that a stalled consumer cannot buffer a model's entire output. The
 * kernel's own send buffer (~233KB here) sits underneath this.
 */
const STREAM_HIGH_WATER = 256 * 1024

export type ChannelHandlers = {
    /** Answer a `call`. Rejecting sends an error reply. */
    call?(verb: string, arg: unknown, signal: AbortSignal): Promise<unknown>
    /** Handle a `send`. Never answered; a throw is reported to onError, never to the peer. */
    send?(verb: string, arg: unknown): void
    /** Answer an `open` by producing a stream. */
    stream?(verb: string, arg: unknown, signal: AbortSignal): AsyncIterable<unknown>
}

type ChannelOpts = {
    socket: ChannelSocket
    handlers?: ChannelHandlers
    /**
     * Where a failure with nowhere else to go is reported.
     *
     * Required, deliberately. These are exactly the errors the capsule's
     * `catch {}` swallowed — a `send` handler throwing, a reply that cannot be
     * written — and a channel with no way to report them is a channel that
     * loses them silently.
     */
    onError(error: Error): void
}

let counter = 0

/**
 * A correlation id unique across BOTH SIDES of the link.
 *
 * The origin segment is load-bearing. Ids used to be
 * `${Date.now()}-${counter++}` with the counter starting at 0 in each
 * process — so a supervisor and its agent issuing a call in the same
 * millisecond minted the SAME id (verified: three calls each, complete
 * overlap). Both sides key `pending` on it, so a reply could match the wrong
 * entry, and `dispatch`'s `if (!entry) return` then dropped the real one
 * silently: the caller's promise never settled, nothing timed out, nothing
 * logged. That is what "the second agent's wake hangs forever" was.
 *
 * A random origin per channel is enough and needs no coordination — the two
 * sides cannot agree on a label without a handshake, and a handshake to
 * number messages is more protocol than the problem deserves.
 */
const origin = Math.random().toString(36).slice(2, 8)
const nextId = () => `${origin}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function Channel(opts: ChannelOpts) {
    const reader = FrameReader()
    const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
    const streams = new Map<string, { push(v: unknown): void; end(e?: Error): void }>()
    const inbound = new Map<string, AbortController>()
    let closed: Error | null = null

    function send(message: Wire): void {
        if (closed) throw closed
        opts.socket.write(encodeMessage(message))
    }

    /** Reply/end writes must never throw into unrelated code — report and move on. */
    function trySend(message: Wire): void {
        try { send(message) } catch (cause) { opts.onError(cause as Error) }
    }

    async function onCall(msg: Extract<Wire, { k: "call" }>): Promise<void> {
        const controller = new AbortController()
        inbound.set(msg.id, controller)
        try {
            if (!opts.handlers?.call) throw err("LINK_NO_HANDLER", { detail: `call ${msg.verb}`, context: { verb: msg.verb, kind: "call" } })
            const value = await opts.handlers.call(msg.verb, msg.arg, controller.signal)
            trySend({ k: "reply", id: msg.id, ok: true, value })
        } catch (cause) {
            trySend({ k: "reply", id: msg.id, ok: false, error: wireError(cause) })
        } finally {
            inbound.delete(msg.id)
        }
    }

    async function onOpen(msg: Extract<Wire, { k: "open" }>): Promise<void> {
        const controller = new AbortController()
        inbound.set(msg.id, controller)
        try {
            if (!opts.handlers?.stream) throw err("LINK_NO_HANDLER", { detail: `stream ${msg.verb}`, context: { verb: msg.verb, kind: "stream" } })
            for await (const value of opts.handlers.stream(msg.verb, msg.arg, controller.signal)) {
                if (controller.signal.aborted) break
                trySend({ k: "chunk", id: msg.id, value })
                // Wait for the wire to drain before producing more. Without
                // this the writer's queue absorbs everything a fast producer
                // emits and a stalled consumer becomes unbounded memory —
                // backpressure that never reaches the thing generating the
                // data is not backpressure.
                const depth = opts.socket.pending ?? 0
                if (depth > STREAM_HIGH_WATER && opts.socket.whenDrained) {
                    await opts.socket.whenDrained(STREAM_HIGH_WATER)
                }
            }
            trySend({ k: "end", id: msg.id, ok: true })
        } catch (cause) {
            trySend({ k: "end", id: msg.id, ok: false, error: wireError(cause) })
        } finally {
            inbound.delete(msg.id)
        }
    }

    function dispatch(msg: Wire): void {
        switch (msg.k) {
            case "call": void onCall(msg); return
            case "open": void onOpen(msg); return
            case "send":
                try { opts.handlers?.send?.(msg.verb, msg.arg) }
                // A fire-and-forget handler has no peer to answer, so a throw
                // here would otherwise become an unhandled rejection.
                catch (cause) { opts.onError(cause as Error) }
                return
            case "reply": {
                const entry = pending.get(msg.id)
                if (!entry) {
                    // A reply nothing is waiting for. Legitimate exactly once
                    // — when the caller aborted and removed its entry first —
                    // and otherwise a correlation fault, which is precisely
                    // the class that used to hang a caller forever with no
                    // record of why. Reported rather than returned into
                    // silence; there is no promise left to reject.
                    opts.onError(new Error(`link: reply for unknown call ${msg.id}`))
                    return
                }
                pending.delete(msg.id)
                msg.ok ? entry.resolve(msg.value) : entry.reject(errorFromWire(msg.error))
                return
            }
            case "chunk": streams.get(msg.id)?.push(msg.value); return
            case "end": {
                const entry = streams.get(msg.id)
                if (!entry) return
                streams.delete(msg.id)
                entry.end(msg.ok ? undefined : errorFromWire(msg.error))
                return
            }
            case "abort": inbound.get(msg.id)?.abort(); return
        }
    }

    return {
        /** Feed bytes read from the socket. */
        receive(chunk: Uint8Array): void {
            let frames: Uint8Array[]
            try {
                frames = reader.push(chunk)
            } catch (cause) {
                // A desynchronised stream cannot be recovered by skipping —
                // every subsequent length prefix is read at the wrong offset.
                this.fail(cause as Error)
                return
            }
            for (const frame of frames) {
                try { dispatch(decodeMessage<Wire>(frame)) }
                catch (cause) { opts.onError(cause as Error) }
            }
        },

        /** Request one value. */
        // `T = unknown` by default. Without the default TypeScript has no
        // inference site for T and resolves it to `undefined`, so every caller
        // that awaited a real value was comparing against `undefined` — a
        // whole class of assertion that could not be written until these tests
        // were typechecked.
        call<T = unknown>(verb: string, arg: unknown, signal?: AbortSignal): Promise<T> {
            if (closed) return Promise.reject(closed)
            const id = nextId()
            return new Promise<T>((resolve, reject) => {
                pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
                signal?.addEventListener("abort", () => {
                    if (!pending.delete(id)) return
                    trySend({ k: "abort", id })
                    reject(new DOMException("aborted", "AbortError"))
                }, { once: true })
                send({ k: "call", id, verb, arg })
            })
        },

        /** Fire-and-forget, ordered. The audit log's verb. */
        send(verb: string, arg: unknown): void {
            send({ k: "send", verb, arg })
        },

        /**
         * Open a stream and consume it as an async generator.
         *
         * Chunks are queued as they arrive and handed out as the consumer
         * pulls. That is what makes backpressure reach the producer: a
         * consumer that stops pulling stops draining the socket, the kernel
         * buffer fills, and the peer's writes go short.
         */
        async *stream<T>(verb: string, arg: unknown, signal?: AbortSignal): AsyncGenerator<T> {
            if (closed) throw closed
            const id = nextId()
            const queue: unknown[] = []
            let done: Error | null | undefined
            let wake: (() => void) | null = null

            streams.set(id, {
                push(value) { queue.push(value); wake?.(); wake = null },
                end(error) { done = error ?? null; wake?.(); wake = null },
            })

            const onAbort = () => {
                trySend({ k: "abort", id })
                streams.delete(id)
                done = new DOMException("aborted", "AbortError")
                wake?.(); wake = null
            }
            signal?.addEventListener("abort", onAbort, { once: true })

            try {
                send({ k: "open", id, verb, arg })
                for (;;) {
                    while (queue.length > 0) yield queue.shift() as T
                    if (done !== undefined) {
                        if (done) throw done
                        return
                    }
                    await new Promise<void>(resolve => { wake = resolve })
                }
            } finally {
                streams.delete(id)
                signal?.removeEventListener("abort", onAbort)
            }
        },

        /**
         * The wire broke. Reject everything outstanding and refuse new work.
         *
         * The capsule lost calls here: its response send was wrapped in a bare
         * `catch {}`, so a completed operation whose reply could not be
         * delivered simply vanished and the caller's promise hung. Failing
         * every pending call explicitly is what makes a dead peer an error
         * rather than a hang.
         */
        fail(error: Error): void {
            if (closed) return
            closed = error
            for (const [id, entry] of pending) { pending.delete(id); entry.reject(error) }
            for (const [id, entry] of streams) { streams.delete(id); entry.end(error) }
            for (const controller of inbound.values()) controller.abort()
            inbound.clear()
            opts.socket.close()
        },

        get isClosed() { return closed !== null },
    }
}

function wireError(cause: unknown): WireError {
    const message = cause instanceof Error ? cause.message : String(cause)
    const fault = cause && typeof cause === "object" && "fault" in cause
        ? (cause as { fault?: unknown }).fault
        : undefined
    return isEngineFault(fault) ? { message, fault } : { message }
}

function errorFromWire(error: WireError): Error {
    return Object.assign(new Error(error.message), error.fault ? { fault: error.fault } : {})
}

function isEngineFault(value: unknown): value is AxonEngineFault {
    if (!value || typeof value !== "object") return false
    const fault = value as Partial<AxonEngineFault>
    return typeof fault.code === "string"
        && typeof fault.message === "string"
        && typeof fault.retryable === "boolean"
        && typeof fault.provider === "string"
}

export type ChannelT = ReturnType<typeof Channel>
