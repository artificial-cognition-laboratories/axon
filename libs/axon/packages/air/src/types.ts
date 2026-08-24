/**
 * AIR — Agent Intermediate Representation.
 *
 * A general-purpose LLM protocol: hand the renderer Axon's domain (base
 * context, declared tools, an event history) and it produces the ordered
 * messages a model sees. AIR owns BOTH halves — render (what the model
 * sees) and parse (what it emits back) — from one grammar, so they cannot
 * drift.
 *
 * The render boundary is DOMAIN in, messages out: callers pass AxonTool[]
 * and AxonEntry[], never AIR's internal render vocabulary. The
 * timeline item shapes below are private to render/ — the exhaustive
 * AxonEntry → item translation lives there, next to the parser it
 * must agree with.
 */

import type { AxonEntry, AxonScope } from "@arcforge/types"

// ── Messages ─────────────────────────────────────────────────────────────────

export type AirMessage = {
    role: "system" | "user" | "assistant"
    content: string
}

// ── Protocols (output grammar) ───────────────────────────────────────────────

/**
 * The named output grammars.
 *
 * classic — <script> computes, <text> speaks. Two INDEPENDENT blocks.
 * raw     — no grammar; the whole reply is the message. For internal calls.
 */
export type AirProtocolName = "classic" | "raw"

/**
 * What a block produces. Every model response reduces to these two: a
 * structure it emitted, and optionally the computation it ran. `<text>` was
 * a template with lang="md"; `<typescript>` was a script. One vocabulary,
 * whatever the protocol.
 */
export type AirModeType = "script" | "text"

export type AirMode = {
    /** The output type this mode produces. */
    type: AirModeType
    /** Optional description override. Falls back to the default for the type. */
    description?: string
}

/** What kind of structure a template holds. */
export type AirTextLang = "md" | "json"

// ── Render input ───────────────────────────────────────────────────────────
//
// DOMAIN in — the caller passes what it already holds. AIR owns every
// translation into protocol shape: tools → <scope> declarations, entries →
// <timeline> items. A cognet curates (which entries, what order, elided how)
// and hands the lists over; it never manufactures AIR-internal types.

export type AirRenderInput = {
    /**
     * Suppress the protocol's opening demonstration exchange.
     *
     * Off by default: the preflight is part of what makes a reply well-formed
     * (see `Protocol.preflight`), so omitting it silently would change model
     * behaviour. Set by callers that want ONLY the conversation they supplied
     * — a test asserting its own turns, a tool rendering a transcript.
     */
    preflight?: false

    /** Base context — the agent's identity contract. Rendered as <system>. */
    base?: string
    /** Capsule-implemented globals. Rendered as <scope lang="ts">. */
    scope?: AxonScope
    /**
     * The structured shape this response must produce, as a TypeScript
     * declaration (`declare const result: { ... }`).
     *
     * Rendered INTO <scope> rather than as a block of its own: the target is
     * a binding the model must produce, exactly as the tools are bindings it
     * may call, and putting it anywhere else would make it a second format
     * to obey instead of ordinary work in a language it already writes.
     */
    output?: string
    /**
     * Arbitrary named data the model should hold as true right now.
     * Rendered as one <state> block each, in the order given.
     *
     * The general answer to "a cognet needs to put data in front of a
     * model". Knowledge catalogues, world beliefs, goals, percept summaries
     * — all the same primitive, because AIR must never grow a block per
     * concept. See AirState.
     */
    state?: readonly AirState[]
    /** The event history to render, already curated by the cognet. Rendered as <timeline>. */
    history?: readonly AxonEntry[]
}

/**
 * One <state> block — a named, timeless assertion about what is currently
 * true.
 *
 * ONE TAG, NOT A TAG PER CONCEPT. A bespoke <knowledge>/<world>/<goals> tag
 * for every kind of data forces the model to infer, per tag, whether it is
 * reading stable belief or transient record — and forces AIR to learn what
 * each concept means, which is a domain opinion a format must not hold. A
 * single stable tag is an attention anchor the model learns once; `name`
 * carries the variance.
 *
 * TIMELESS BY CONSTRUCTION. State is what IS; the timeline is what
 * HAPPENED. A belief that is three turns stale is still the current belief,
 * so recency belongs inside `content` as an ordinary field the cognet
 * writes, never as a timestamp AIR branches on to decide placement. A
 * cognet that wants an event in the causal record emits a stimulus — that
 * path already exists.
 */
export type AirState = {
    /** The handle the model refers to this block by. */
    name: string
    /**
     * What the data IS — never an instruction about what to do with it.
     *
     * Narrow on purpose: instructions belong in <system>, and a description
     * that starts telling the model how to behave makes state blocks a
     * second place identity lives. `name` alone is opaque ("knowledge" plus
     * a JSON blob says nothing), so this exists to make the payload legible
     * and stops there.
     */
    description?: string
    /** How `content` is serialized when it is a value. Default "json". */
    lang?: AirStateLang
    /**
     * A value AIR serializes, or a pre-rendered string it passes through
     * untouched.
     *
     * Both, because the two callers are real: a cognet holding a plain
     * object should not have to stringify it, and one that has already
     * formatted its own material must not have that reformatted underneath
     * it. A string is taken as authored; anything else is serialized per
     * `lang`.
     */
    content: unknown
}

/** Serializations a <state> block declares. */
export type AirStateLang = "json" | "yaml" | "ts"

// ── Parser output ────────────────────────────────────────────────────────────

/**
 * Events emitted by the streaming AIR parser.
 *
 * *:delta — tokens inside a streamable block, in real time.
 * *:done  — a block closed; content is the full inner text.
 *           `incomplete: true` means the stream ended without the closing tag —
 *           callers must treat these as format errors, never as valid actions.
 *
 * A template streams because nothing downstream depends on it. A script does
 * not: it is code, and half a statement is not runnable.
 */
export type AirBlockEvent =
    | { type: "text:open"; lang: AirTextLang }
    | { type: "text:delta"; content: string }
    | { type: "text:done"; content: string; incomplete?: true }
    | { type: "script:done"; content: string; incomplete?: true }
    | { type: "thinking:delta"; content: string }
    | { type: "thinking:done"; content: string; incomplete?: true }
    /**
     * A <done/> tag — the model saying its turn is over.
     *
     * A SIGNAL, never an instruction. Nothing in the runtime acts on it; a
     * loop reads it alongside what the response structurally did and makes
     * its own decision.
     *
     * It is here under protest. Whether a turn is over is a semantic
     * question — a progress report and a final answer are structurally
     * identical, so no reduction over blocks can tell them apart — and until
     * something can judge that, asking the model is the only thing that
     * works consistently. See the note in protocol.ts.
     */
    | { type: "done" }
