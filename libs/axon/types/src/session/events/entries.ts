import type { AxonStimulusEvent } from "./stdio/stimuli"
import type { AxonOutputEvent } from "./stdio/output"

/**
 * Entry registry — everything that can be a durable entry in the session's
 * one log. There is no thread/branching concept: one cognet instance is
 * always exactly one continuous stream. A temporally-extended emission is
 * ordinary chunked entries (the AxonChunk standard, stdio/shared.ts) —
 * every chunk is itself a durable committed entry, so streaming rides the
 * same log as everything else; there is no separate transient delta wire.
 * Raw engine-level deltas (AxonEngineDelta) still exist, but only inside
 * kernel.stream()'s engine wire — they never reach this log. A user who
 * wants multiple independent conversations runs multiple Axon() instances
 * — a host-level (TUI) concern, never something the log or the cognet has
 * to represent internally.
 *
 * Four families:
 * - stimulus:*  — exteroception: the world reaching the agent (stdio/stimuli.ts).
 *                 A user message is cognet:stimulus:text on channel "user".
 * - output:*    — effectorception: the cognet reaching the world, unmediated
 *                 (stdio/output.ts). Committed exclusively by kernel.output()
 *                 — the cognet never calls session.commit directly; it has
 *                 no session access at all, only output() and run().
 * - action:*    — a mediated request the cognet made (run()) and its
 *                 outcome. Committed exclusively by the kernel's run()
 *                 implementation, the moment the capsule's own
 *                 cmd:complete/cmd:failed lands — same pattern as
 *                 capsule:attach/detach, never something cognet code writes.
 * - the rest    — interoception: machine-body facts (interrupts).
 */
/**
 * The entry namespaces — the only event families that may appear in the
 * session's log. Anything filtering "is this a log entry?" (wire filters,
 * renderers) derives from THIS list, never from its own prefix sniff: a new
 * family added to AxonEntryEvent must be added here in the same change.
 */
export const ENTRY_EVENT_PREFIXES = ["cognet:stimulus:", "cognet:output:", "cognet:action:", "axon:interrupt", "axon:system:"] as const

export type AxonEntryEvent = AxonStimulusEvent & AxonOutputEvent & {
    /** Kernel signal record — an interrupt is machinery, never a stimulus. */
    "axon:interrupt": { reason: "user" | "shutdown" }

    /** Code the cognet ran via kernel.run(). `id` is referenced by cognet:action:result.for. */
    "cognet:action:typescript": { id: string; content: string }
    /** The outcome of one run() call — without this, a resumed log renders code with its stdout missing. */
    "cognet:action:result": {
        /** id of the cognet:action:typescript block this answers */
        for: string
        ok: boolean
        content: string
        error?: { kind: "timeout" | "policy" | "interrupt" | "exception"; message: string }
    }

    /**
     * A durable system interaction in the session's causal timeline.
     * AIR renders every member through the single <system> emitter; `type`
     * narrows its meaning and `lang` describes the content representation.
     */
    "axon:system:message": {
        type: string
        lang: string
        content: string
        /** Additional trusted AIR attributes. `type` and `lang` are reserved. */
        attributes?: Record<string, string>
    }
}
