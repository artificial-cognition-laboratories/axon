import type { SpanStore, TraceSpan } from "./span-store"

/**
 * No AsyncLocalStorage in a browser — and practically no need for it: one
 * tab isn't juggling multiple unrelated concurrent request trees the way a
 * server process is. A single module-level "current span" is an honest
 * simplification, not a shortcut.
 */
export function createSpanStore(): SpanStore {
    let current: TraceSpan | undefined
    return {
        getStore: () => current,
        run<T>(span: TraceSpan, fn: () => T): T {
            const previous = current
            current = span
            try {
                return fn()
            } finally {
                current = previous
            }
        },
    }
}
