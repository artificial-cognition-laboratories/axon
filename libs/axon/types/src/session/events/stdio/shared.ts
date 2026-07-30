/**
 * Shapes shared by both directions of the stdio protocol — stimuli (world
 * → cognet) and output (cognet → world). Neither file imports from the
 * other; anything both need lives here so the two stay siblings, not one
 * depending on the other's internals.
 */

/**
 * Content-addressed reference to a heavy payload (audio segment, frame,
 * clip) held OUTSIDE the log — device buffer, blob store, agent home.
 * The log entry stays ~bytes regardless of modality; replay never needs
 * the blob (the digest is what cognition folds).
 */
export type StimulusRef = {
    /** content address or storage uri */
    uri: string
    mime: string
    bytes?: number
}

/**
 * The chunking standard — how a temporally-extended emission is recorded.
 *
 * An emission is a correlated GROUP of 1..n committed entries: every chunk
 * of one emission carries the same `of` id, and the group closes when a
 * chunk arrives with `final: true`. The group — not any single entry — is
 * the fact; the complete content is the in-order concatenation/assembly of
 * its chunks. `chunk` absent means the entry is a self-contained complete
 * emission (the degenerate 1-chunk case, no folding required).
 *
 * This is a standard DIMENSION of every output kind, not a type family —
 * a chunk of text is still cognet:output:text (information kind), the same way
 * time.seq is a dimension of the envelope. Every observer applies ONE
 * folding rule to every kind forever: group by `of`, order by seq, closed
 * by `final`. A group that never receives its final chunk was truncated
 * (interrupt, crash) — truncation is representable in the durable record,
 * not a lie of omission.
 *
 * Granularity is entirely the EMITTER's dial: one self-contained entry
 * (zero overhead) or token-level chunks (live typing, one durable append +
 * bus forward per chunk — a chosen cost, never a surprise). The cognet
 * just emits at whatever granularity is natural to it; rate/size ceilings
 * are a runtime/consumer concern, never the emitter's.
 */
export type AxonChunk = {
    /** correlation id shared by every chunk of one emission */
    of: string
    /** closes the group — the emission is complete */
    final?: boolean
}
