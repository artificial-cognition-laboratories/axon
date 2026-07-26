/**
 * The Axon event envelope — one shape for every event in the system.
 *
 * Design rules (hold these or the event system rots):
 * 1. Call sites emit (type, data) only. id, time, and context are stamped
 *    by the emitter (session/run), in exactly one place.
 * 2. Correlation lives in context, never in data. If a field says WHERE the
 *    event belongs (run, span) it is context; if it says WHAT
 *    happened (code, tokens, duration) it is data.
 * 3. Classification comes from the type namespace and from which log the
 *    event lives in. No source/layer/audience fields.
 * 4. Failure payloads carry the full AxonError (@axon/err) in data,
 *    verbatim — no compact/wire projection. This is a debugging log, not a
 *    bandwidth-constrained wire protocol: anything tailing the session
 *    JSONL (a debugger, a session viewer) sees one recognizable shape
 *    (isAxonError: true) and can render the complete report — code, title,
 *    description, context, captured stack frames with source snippets,
 *    cause chain — directly off disk, with nothing lost between the
 *    moment of failure and whoever reads the log later.
 * 5. Ingest-time fields (receivedAt, userId) are a backend wrapper — they
 *    do not exist on the wire type.
 */

export type AxonEventContext = {
    agentId: string
    sessionId: string
    /** One kernel request = one runId. The unit of "what the user asked for". */
    runId?: string
    /** Tracing tree — minted per run, parented per phase/system. */
    traceId?: string
    spanId?: string
    parentSpanId?: string
}

/**
 * The envelope. `M` is a registry map (event name → payload shape);
 * `K` narrows to one event type.
 */
export type AxonEvent<M, K extends keyof M = keyof M, C extends object = AxonEventContext> = {
    /** UUIDv7 — globally unique and time-sortable. Idempotent ingest. */
    id: string
    type: K
    time: {
        /** Wall clock ms since epoch. */
        ms: number
        /** Monotonic per-session counter — authoritative ordering, immune to clock skew. */
        seq: number
    }
    context: C
    /** Typed payload — the registry map is the single source of payload truth. */
    data: M[K]
}

/** Discriminated union of enveloped events for a registry map. */
export type AxonEventUnion<M, C extends object = AxonEventContext> = { [K in keyof M]: AxonEvent<M, K, C> }[keyof M]

/** Backend-side wrapper — stamped at ingest, never constructed by the runtime. */
export type AxonIngestedEvent<M> = AxonEventUnion<M> & {
    receivedAt: number
    userId: string
}
