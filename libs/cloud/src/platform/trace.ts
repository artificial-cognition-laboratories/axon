/**
 * Ambient trace context — the one trace tree for the whole client.
 *
 * Module-level by design (same move as `home` in core): nobody constructs
 * or passes it. AsyncLocalStorage carries the active span across awaits, so
 * concurrent operations each hold their own branch with zero plumbing.
 *
 * Consumers:
 *   Http         — auto-spans every request, stamps wire headers
 *   ws3 connect  — reads current() to parent engine events into the tree
 *   BatchEmitter — subscribes via onSpanEnd() when ingest lands
 *
 * Wire format matches the backend: x-axon-trace-id / x-axon-span-id.
 */

/**
 * Node/Bun get real AsyncLocalStorage (span-store.node.ts) — the active
 * span survives concurrent unrelated async chains without threading it
 * through every call. Browsers get a module-level variable
 * (span-store.browser.ts): no node:async_hooks, and practically no need for
 * it — one tab isn't juggling multiple unrelated concurrent request trees
 * the way a server process is. Both implement the same SpanStore shape, so
 * nothing here branches on runtime — package.json's "browser" field picks
 * the right file at bundle time, so the Node build never enters a browser
 * bundle graph.
 */
import { createSpanStore } from "./span-store"
import type { TraceSpan, TraceSpanEnd } from "./span-store"

export type { TraceSpan, TraceSpanEnd } from "./span-store"

const als = createSpanStore()
const endHandlers = new Set<(span: TraceSpanEnd) => void>()

function emitEnd(span: TraceSpan, error?: string): void {
    const ended: TraceSpanEnd = {
        ...span,
        durationMs: Date.now() - span.startedAt,
        ...(error !== undefined ? { error } : {}),
    }
    for (const handler of endHandlers) {
        handler(ended)
    }
}

export const trace = {
    /** The active span, if any operation is in flight on this async path. */
    current(): TraceSpan | undefined {
        return als.getStore()
    },

    /** Wire headers for the active span — Http stamps these on every request. */
    headers(): Record<string, string> | undefined {
        const span = als.getStore()
        if (!span) return undefined
        return {
            "x-axon-trace-id": span.traceId,
            "x-axon-span-id": span.spanId,
        }
    },

    /**
     * Run fn inside a named span. Children of the active span join its
     * trace; with no active span this mints a new trace root. The span ends
     * when fn settles — errors are recorded on the span and rethrown.
     */
    async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const parent = als.getStore()

        const span: TraceSpan = {
            traceId: parent?.traceId ?? crypto.randomUUID(),
            spanId: crypto.randomUUID(),
            ...(parent ? { parentSpanId: parent.spanId } : {}),
            name,
            startedAt: Date.now(),
        }

        return als.run(span, async () => {
            try {
                const result = await fn()
                emitEnd(span)
                return result
            } catch (error) {
                emitEnd(span, error instanceof Error ? error.message : String(error))
                throw error
            }
        })
    },

    /**
     * Join an existing trace (e.g. a runtime that already minted a traceId
     * for the whole session/request) — everything inside runs as part of it.
     */
    async adopt<T>(ctx: { traceId: string; spanId?: string }, name: string, fn: () => Promise<T>): Promise<T> {
        const span: TraceSpan = {
            traceId: ctx.traceId,
            spanId: crypto.randomUUID(),
            ...(ctx.spanId !== undefined ? { parentSpanId: ctx.spanId } : {}),
            name,
            startedAt: Date.now(),
        }

        return als.run(span, async () => {
            try {
                const result = await fn()
                emitEnd(span)
                return result
            } catch (error) {
                emitEnd(span, error instanceof Error ? error.message : String(error))
                throw error
            }
        })
    },

    /** Subscribe to completed spans — BatchEmitter's feed. Returns unsubscribe. */
    onSpanEnd(handler: (span: TraceSpanEnd) => void): () => void {
        endHandlers.add(handler)
        return () => { endHandlers.delete(handler) }
    },
}
