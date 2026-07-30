import { err } from "@arcforge/err"
import type { AxonEventMap } from "@arcforge/types"

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventHandler<T> = (payload: T) => void | Promise<void>

export type BusHistoryEntry = {
    event: string
    payload: unknown
    ts: number
}

/**
 * AxonBus — the central observable event channel for the Axon runtime.
 *
 * Carries everything in AxonEventMap — runtime lifecycle (axon:boot:*,
 * axon:shutdown:*, axon:reload:*), kernel and cognet telemetry, capsule
 * events, and the session's entries. The session commit pipeline forwards
 * each event here AFTER it is durable, so a bus subscriber never sees
 * something that failed to persist.
 *
 * NOT the durable record — that is the session log. This is live
 * notification: the server bridges it to SSE (/_axon/events), the TUI
 * subscribes for live rendering, and tests assert against history(). An
 * event that only reaches the bus is gone when the process ends.
 *
 * Distinct from Hooks(): this is many-to-many fire-and-forget notification;
 * hooks are call-and-await-to-completion at a fixed runtime call point.
 *
 * Generic EventMap lets user-defined events be typed alongside built-ins.
 */
export type AxonBusT<EventMap extends Record<string, unknown> = AxonEventMap> = {
    /**
     * Emit an event. Awaits all registered handlers before resolving.
     * Errors in handlers are caught and re-emitted as "axon:bus:error" (non-fatal).
     */
    emit<K extends keyof (AxonEventMap & EventMap)>(
        event: K,
        payload: (AxonEventMap & EventMap)[K],
    ): Promise<void>

    /**
     * Subscribe to an event. Returns an unsubscribe function.
     * Handlers are called in registration order (use priority via hooks for ordering).
     */
    on<K extends keyof (AxonEventMap & EventMap)>(
        event: K,
        handler: EventHandler<(AxonEventMap & EventMap)[K]>,
    ): () => void

    /**
     * Subscribe to an event exactly once. Auto-unsubscribes after first call.
     */
    once<K extends keyof (AxonEventMap & EventMap)>(
        event: K,
        handler: EventHandler<(AxonEventMap & EventMap)[K]>,
    ): () => void

    /**
     * Unsubscribe a specific handler from an event.
     */
    off(event: string, handler: EventHandler<unknown>): void

    /**
     * All events emitted since the bus was created, in order.
     * Useful for test assertions and debugging.
     * Optionally filter by event name or limit to last N entries.
     */
    history(opts?: { limit?: number; event?: string }): BusHistoryEntry[]

    /**
     * Clear the history buffer (e.g. between test cases).
     */
    clearHistory(): void

    /**
     * Subscribe to ALL events. Handler receives the event name and payload.
     * Used by the WebSocket bus relay to forward events to connected TUI clients.
     * Returns an unsubscribe function.
     */
    onAny(handler: (event: string, payload: unknown) => void): () => void

    /**
     * Relay an externally-typed event onto the bus without static payload
     * checking — for boundaries that forward another system's event stream
     * (capsule, Cognos). The event's own `type` field is the bus event name.
     */
    forward(event: { type: string }): Promise<void>
}

// ── Implementation ────────────────────────────────────────────────────────────

export function AxonBus<EventMap extends Record<string, unknown> = AxonEventMap>(opts?: { maxHistory?: number }): AxonBusT<EventMap> {
    const maxHistory = opts?.maxHistory ?? 1000
    type FullMap = AxonEventMap & EventMap

    // handler map: event name → ordered list of handlers
    const handlers = new Map<string, Array<EventHandler<unknown>>>()

    // wildcard handlers — called for every emitted event
    const anyHandlers = new Set<(event: string, payload: unknown) => void>()

    // history ring — all emitted events, in order
    const _history: BusHistoryEntry[] = []

    function getHandlers(event: string): Array<EventHandler<unknown>> {
        if (!handlers.has(event)) handlers.set(event, [])
        return handlers.get(event)!
    }

    function on(event: string, handler: EventHandler<unknown>): () => void {
        getHandlers(event).push(handler)
        return () => off(event, handler)
    }

    function once(event: string, handler: EventHandler<unknown>): () => void {
        const wrapper: EventHandler<unknown> = async (payload) => {
            off(event, wrapper)
            await handler(payload)
        }
        return on(event, wrapper)
    }

    function off(event: string, handler: EventHandler<unknown>): void {
        const list = handlers.get(event)
        if (!list) return
        const idx = list.indexOf(handler)
        if (idx !== -1) list.splice(idx, 1)
    }

    /** Strip non-serialisable fields (functions) from a payload before storing in history. */
    function sanitiseForHistory(payload: unknown): unknown {
        if (payload === null || typeof payload !== "object") return payload
        const result: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
            if (typeof v !== "function") result[k] = v
        }
        return result
    }

    async function emit(event: string, payload: unknown): Promise<void> {
        if (_history.length >= maxHistory) {
            _history.shift()
        }
        _history.push({ event, payload: sanitiseForHistory(payload), ts: Date.now() })

        const list = getHandlers(event).slice() // snapshot — handlers may mutate during iteration
        for (const handler of list) {
            try {
                await handler(payload)
            } catch (cause) {
                // A handler failure is a real failure — plugins and modules
                // register handlers, so a silently-broken one is invisible
                // rot. Constructing it through err() delivers it to the
                // session's error sink (errScope), which is what makes it
                // durable; previously this only reached the in-memory
                // history ring and stderr, so nothing about a failing
                // plugin handler ever survived the process.
                const failure = err("BUS_HANDLER_FAILED", {
                    detail: `handler for "${event}" threw`,
                    context: { event },
                    cause,
                })
                // Recursion guard: a failing axon:bus:error handler must not
                // re-enter this path forever. Its own failure is already
                // recorded by err() above.
                if (event !== "axon:bus:error") {
                    await emit("axon:bus:error", { event, error: failure })
                }
            }
        }

        // Wildcard handlers are non-fatal, but failures are surfaced.
        for (const handler of anyHandlers) {
            try {
                handler(event, payload)
            } catch (anyHandlerError) {
                console.warn(`[axon:bus] wildcard handler error on "${event}":`, anyHandlerError)
            }
        }
    }

    return {
        emit: emit as AxonBusT<EventMap>["emit"],
        on: on as AxonBusT<EventMap>["on"],
        once: once as AxonBusT<EventMap>["once"],
        off: off as AxonBusT<EventMap>["off"],
        history(opts?: { limit?: number; event?: string }): BusHistoryEntry[] {
            let result = opts?.event
                ? _history.filter(e => e.event === opts.event)
                : [..._history]
            if (opts?.limit !== undefined) {
                result = result.slice(-opts.limit)
            }
            return result
        },
        clearHistory(): void { _history.length = 0 },
        onAny(handler: (event: string, payload: unknown) => void): () => void {
            anyHandlers.add(handler)
            return () => { anyHandlers.delete(handler) }
        },
        forward(event: { type: string }): Promise<void> {
            return emit(event.type, event)
        },
    }
}
