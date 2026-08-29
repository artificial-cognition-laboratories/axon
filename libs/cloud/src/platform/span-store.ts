export type TraceSpan = {
    /** Root ID minted at the system boundary — shared by every span in the chain. */
    traceId: string
    /** This span's own ID. */
    spanId: string
    /** Parent span — absent on a root. */
    parentSpanId?: string
    /** Semantic operation name, e.g. "billing.ledger", "http POST /api/ingest/events". */
    name: string
    startedAt: number
}

export type TraceSpanEnd = TraceSpan & {
    durationMs: number
    error?: string
}

export type SpanStore = {
    getStore(): TraceSpan | undefined
    run<T>(span: TraceSpan, fn: () => T): T
}

/** package.json "browser" field swaps this for span-store.browser.ts in a browser build. */
export { createSpanStore } from "./span-store.node"
