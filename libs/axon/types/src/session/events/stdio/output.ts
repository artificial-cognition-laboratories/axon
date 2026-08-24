import type { AxonChannel, AxonChunk, AxonTextFormat, StimulusRef } from "./shared"

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
 *    describes what the data IS (text, audio, visual, a measurement),
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
 *
 * 5. Every emission carries a CHANNEL, mirroring stimuli exactly. Outbound
 *    addressing is the same problem as inbound: a cognet writing to
 *    /cmd_vel and /speaker is not doing one thing, and an observer that
 *    cannot separate them cannot debug either. Required, never defaulted —
 *    a fallback channel would silently merge two lines that a mind
 *    deliberately kept apart.
 */

// ── The output set ───────────────────────────────────────────────────────────

/**
 * The output registry — log entries, unmediated at the call site.
 *
 * Four kinds, mirroring stimuli exactly:
 *   text    — symbolic language out (an LLM cognet's natural output)
 *   audio   — synthesized sound out (a cognet that speaks directly)
 *   visual  — an image or clip produced/selected by the cognet
 *   vector  — a measured/declared quantity emitted outward: a motor
 *             command, a homeostatic reading, telemetry, a target pose
 */
export type AxonOutputEvent = {
    /** Symbolic language output. Inline — text IS its own digest. */
    "cognet:output:text": {
        channel: AxonChannel
        content: string
        /** how to read it — "json", "markdown"; absent = plain prose */
        format?: AxonTextFormat
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }

    /** Synthesized or selected audio segment. */
    "cognet:output:audio": {
        channel: AxonChannel
        ref: StimulusRef
        /** symbolic digest — what the emission means without fetching audio */
        transcript?: string
        durationMs?: number
        /** chunking standard (shared.ts) — audio's natural durable shape is chunked */
        chunk?: AxonChunk
    }

    /** An image or clip the cognet produced or selected. */
    "cognet:output:visual": {
        channel: AxonChannel
        ref: StimulusRef
        /** symbolic digest — caption / description */
        caption?: string
        kind: "image" | "video"
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }

    /**
     * A measurement the cognet declares outward — a motor command, a
     * homeostatic reading, telemetry, a target pose.
     *
     * The exact mirror of the stimulus kind, and for the same reasons: one
     * instrument, one instant, always an array. A wheel-velocity command is
     * `[left, right]` and is one act, not two — the same atomicity argument
     * that applies to sensing applies to acting.
     */
    "cognet:output:vector": {
        channel: AxonChannel
        /** the emission — one sample, one or more components */
        values: number[]
        /** what the numbers are in when every component shares one */
        unit?: string
        /** per-component units, same length as `values` — see the stimulus kind */
        units?: string[]
        /** what each component is, same length as `values` */
        labels?: string[]
        /** the convention these values follow — advisory, never validated */
        profile?: string
        /** for emissions too large to inline */
        ref?: StimulusRef
        /** chunking standard (shared.ts) — absent = self-contained complete emission */
        chunk?: AxonChunk
    }
}

export type AxonOutputType = keyof AxonOutputEvent
