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

// ── Modes (output grammar) ───────────────────────────────────────────────────

export type AirModeType = "text" | "typescript" | "shell"

export type AirMode = {
    /** The output type this mode produces. */
    type: AirModeType
    /** Optional description override. Falls back to the default for the type. */
    description?: string
}

// ── Render input ───────────────────────────────────────────────────────────
//
// DOMAIN in — the caller passes what it already holds. AIR owns every
// translation into protocol shape: tools → <scope> declarations, entries →
// <timeline> items. A cognet curates (which entries, what order, elided how)
// and hands the lists over; it never manufactures AIR-internal types.

export type AirRenderInput = {
    /** Base context — the agent's identity contract. Rendered as <system>. */
    base?: string
    /** Capsule-implemented globals. Rendered as <scope lang="ts">. */
    scope?: AxonScope
    /** The event history to render, already curated by the cognet. Rendered as <timeline>. */
    history?: readonly AxonEntry[]
}

// ── Parser output ────────────────────────────────────────────────────────────

/**
 * Events emitted by the streaming AIR parser.
 *
 * *:delta — tokens inside a streamable block (<text>, <thinking>), real time.
 * *:done  — a block closed; content is the full inner text.
 *           `incomplete: true` means the stream ended without the closing tag —
 *           callers must treat these as format errors, never as valid actions.
 * done    — a <done/> self-closing tag was encountered.
 */
export type AirBlockEvent =
    | { type: "text:delta"; content: string }
    | { type: "text:done"; content: string; incomplete?: true }
    | { type: "thinking:delta"; content: string }
    | { type: "thinking:done"; content: string; incomplete?: true }
    | { type: "typescript:done"; content: string; incomplete?: true }
    | { type: "shell:done"; content: string; incomplete?: true }
    | { type: "done" }
