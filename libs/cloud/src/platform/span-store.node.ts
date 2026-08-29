import { AsyncLocalStorage } from "node:async_hooks"
import type { SpanStore, TraceSpan } from "./span-store"

export function createSpanStore(): SpanStore {
    const impl = new AsyncLocalStorage<TraceSpan>()
    return {
        getStore: () => impl.getStore(),
        run: (span, fn) => impl.run(span, fn),
    }
}
