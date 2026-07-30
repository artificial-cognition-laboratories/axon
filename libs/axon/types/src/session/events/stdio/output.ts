import type { AxonChunk, StimulusRef } from "./shared"

/**
 * Output — the effector protocol. Every fact a cognet emits TO the world
 * that isn't a mediated request (that's run() — a tool call, policy-gated,
 * may fail) goes through here. The mirror image of stimuli.ts: stimuli are
 * exteroception (the world reaching the agent), output is effectorception
 * (the agent reaching the world) — same design rules, same reasoning,
 * applied to the opposite direction.
 *
 * DESIGN RULES (identical to stimuli.ts, mirrored):
 *
 * 1. Top-level types are INFORMATION KINDS, not pipeline stages. A kind
 *    describes what the data IS (text, audio, visual, a measured value),
 *    never WHEN or HOW a cognet produced it. "Thinking" is deliberately
 *    absent: it never described a data kind — it described a stage in one
 *    specific engine's pipeline (LLM reasoning-before-answer), the same
 *    category error kernel:engine:* telemetry would be if it leaked into
 *    this protocol. A cognet with something analogous to reasoning is free
 *    to emit it as cognet:output:text like anything else; if it wants to mark it
 *    distinctly for a renderer, that's optional per-kind metadata, not a
 *    new top-level type — a "was this exploratory" flag is cognet-internal
 *    narrative, not a property of the output protocol.
 *
 * 2. Heavy payloads NEVER enter the log — same ref/digest split as stimuli:
 *    a `ref` into content-addressed storage, plus whatever symbolic digest
 *    makes the emission durable and replayable without the bytes.
 *
 * 3. Output is EFFECTORCEPTION — the cognet reaching the world. Unmediated
 *    at the call site: writing to your own stdout can't itself harm
 *    anything, so there is nothing here for the kernel to refuse (contrast
 *    run() — a request whose EFFECT needs permission before it happens).
 *    Any filtering, redaction, or policy a host wants to apply happens
 *    downstream of the commit, on the delivery/render path — never as a
 *    gate the emitting call has to pass through, the same way a shell
 *    pipeline filters a process's stdout without the process negotiating
 *    with the pipe.
 *
 * 4. Outputhood is a DELIVERY ROLE, not a type property — same as
 *    stimulushood. These are ordinary log entries; a renderer or
 *    devtools view derives "is this an output?" from the type prefix, the
 *    same way it derives "is this a stimulus?" from stimulus:*.
 */

// ── The output set ───────────────────────────────────────────────────────────

/**
 * The output registry — log entries, unmediated at the call site.
 *
 * Four kinds, mirroring stimuli exactly:
 *   text    — symbolic language out (an LLM cognet's natural output)
 *   audio   — synthesized sound out (a cognet that speaks directly)
 *   visual  — an image or clip produced/selected by the cognet
 *   field   — a measured/declared value emitted outward (a fish declaring
 *             a homeostatic reading, telemetry, a structured status)
 */
export type AxonOutputEvent = {
    /** Symbolic language output. Inline — text IS its own digest. */
    "cognet:output:text": {
        content: string
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }

    /** Synthesized or selected audio segment. */
    "cognet:output:audio": {
        ref: StimulusRef
        /** symbolic digest — what the emission means without fetching audio */
        transcript?: string
        durationMs?: number
        /** chunking standard (shared.ts) — audio's natural durable shape is chunked */
        chunk?: AxonChunk
    }

    /** An image or clip the cognet produced or selected. */
    "cognet:output:visual": {
        ref: StimulusRef
        /** symbolic digest — caption / description */
        caption?: string
        kind: "image" | "video"
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }

    /** A value the cognet declares outward — status, telemetry, a homeostatic reading. */
    "cognet:output:field": {
        reading: { value: number | string | boolean; unit?: string }
        ref?: StimulusRef
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }
}

export type AxonOutputType = keyof AxonOutputEvent
