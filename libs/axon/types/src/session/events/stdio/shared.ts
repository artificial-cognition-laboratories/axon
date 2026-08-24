/**
 * Shapes shared by both directions of the stdio protocol — stimuli (world
 * → cognet) and output (cognet → world). Neither file imports from the
 * other; anything both need lives here so the two stay siblings, not one
 * depending on the other's internals.
 */

/**
 * The address a fact crossed the interface on — inbound or outbound.
 *
 * Open vocabulary, world-defined: "user", "mic0", "/camera/front/image_raw",
 * "email:inbox", "/cmd_vel", "speaker". The TYPE says what kind of
 * information it is; the CHANNEL says which line it arrived on or left by.
 * Together they are the entire addressing scheme, and deliberately the only
 * thing a cognet learns about its interface — a mind knows it received audio
 * on /mic/left, never what hardware sits behind it or who is upstream.
 *
 * This replaced `StimulusSource = { channel, id? }`, a struct named for
 * producer identity that only ever carried an address. The `id` half was
 * declared and never populated by any producer or read by any consumer: a
 * mind has no use for who is speaking that the channel does not already
 * answer, and a participant identity that matters belongs in the payload as
 * content, not in the envelope as routing.
 *
 * Both directions carry one. A robot with two speakers, or a cognet writing
 * to /cmd_vel and /speaker, has the same addressing problem outbound as a
 * ROS network has inbound — a mind emitting to two lines is not doing one
 * thing, and an observer that cannot tell them apart cannot debug either.
 *
 * ── CONVENTION: CHANNEL MODULES ──────────────────────────────────────────
 *
 * A channel module (Telegram, Discord, Slack, SMS) names its channels
 * `"<module>:<address>"` — `"telegram:123456789"`, `"discord:9876"`. Two
 * rules, and they exist for different reasons:
 *
 * 1. The MODULE PREFIX keeps the namespace collision-free. An agent with
 *    both Telegram and Discord installed would otherwise see two `"chat"`
 *    channels and could answer one person on the other's transport.
 *
 * 2. The ADDRESS is what makes a reply possible. The mind reads the channel
 *    off the stimulus it is answering and hands that address to the module's
 *    send tool. This is the whole return path, and it is stateless by
 *    construction: two people messaging at once produce two stimuli each
 *    carrying its own return address, so nothing upstream has to remember
 *    who spoke last. A module whose send tool targets "the last sender"
 *    instead has moved an addressing decision out of the mind and into a
 *    hidden global, where concurrency breaks it.
 *
 * WHO IS SPEAKING GOES IN THE PAYLOAD, NOT HERE. The channel is routing; the
 * sender is content the mind should weigh — including when deciding whether
 * to trust the request at all. This is why `StimulusSource = { channel, id? }`
 * collapsed to a bare address: participant identity that matters is content.
 */
export type AxonChannel = string

/**
 * How to read a text payload — the protocol layer for symbols.
 *
 * The mirror of `ref.mime` for audio and visual: those carry opaque bytes
 * and need a decoder named, and text carries readable characters that may
 * still be structured. A cognet handed `{"cmd":"stop"}` should know it is
 * JSON rather than infer it from a leading brace.
 *
 * Open vocabulary, IANA-shaped where one exists. Absent means plain prose,
 * which is what a person speaking or typing produces.
 */
export type AxonTextFormat = string

/**
 * Dense media — held in the session's bounded sensory ring, never in the
 * durable log. Everything not in this set is durable.
 *
 * BOTH DIRECTIONS, because the argument was never about direction. A 30Hz
 * microphone commits ~2.6M entries a day whose bytes nobody will replay,
 * and a cognet that SPEAKS at 30Hz commits exactly as many — an echoing
 * agent measured 1.5MB of log in forty seconds, all of it base64 PCM the
 * record will carry forever. Durability is a property of the KIND, and a
 * kind does not become cheap by being emitted rather than sensed.
 *
 * What stays durable is the symbolic layer: text, field readings, actions,
 * results. That is the useful record — what was said and what was done —
 * and it is unaffected by any of this. The digests travel with it, so an
 * audio emission's transcript and a frame's caption remain in the log
 * permanently even though the samples and pixels do not.
 *
 * The ring is bounded and configurable, and at size 0 this set behaves
 * exactly as a pure transient tier: delivered, observed live, never
 * stored. See SensoryRing in @arcforge/session.
 */
export const SENSORY_EVENTS = new Set<string>([
    "cognet:stimulus:audio",
    "cognet:stimulus:visual",
    "cognet:output:audio",
    "cognet:output:visual",
])

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
