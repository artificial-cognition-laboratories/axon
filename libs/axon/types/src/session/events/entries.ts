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
 *                 A terminal message is cognet:stimulus:text on channel "terminal".
 * - output:*    — effectorception: the cognet reaching the world, unmediated
 *                 (stdio/output.ts). Committed exclusively by kernel.output()
 *                 — the cognet never calls session.commit directly; it has
 *                 no session access at all, only output() and run().
 * - action:*    — a mediated request the cognet made (run()) and its
 *                 outcome. Committed exclusively by the kernel's run()
 *                 implementation, the moment the capsule's own
 *                 cmd:complete/cmd:failed lands — same pattern as
 *                 capsule:attach/detach, never something cognet code writes.
 * - agent:*     — the agent's own control signals, as opposed to what it
 *                 emitted to the world. `axon:agent:done` is the turn it
 *                 declared over; it reaches nobody outside the runtime, but
 *                 it is part of the record the model reads back.
 * - the rest    — interoception: machine-body facts (interrupts).
 */
/**
 * The entry namespaces — the only event families that may appear in the
 * session's log. Anything filtering "is this a log entry?" (wire filters,
 * renderers) derives from THIS list, never from its own prefix sniff: a new
 * family added to AxonEntryEvent must be added here in the same change.
 */
export const ENTRY_EVENT_PREFIXES = ["cognet:stimulus:", "cognet:output:", "cognet:action:", "axon:interrupt", "axon:system:", "axon:agent:"] as const

export type AxonEntryEvent = AxonStimulusEvent & AxonOutputEvent & {
    /** Kernel signal record — an interrupt is machinery, never a stimulus. */
    /**
     * A run cut short.
     *
     * `reason` is WHY — a person changed their mind, or the process is going
     * down. `from` is WHICH SURFACE said so, the same vocabulary a stimulus
     * channel uses (`terminal`, `axon-cli`, `telegram:…`). They answer
     * different questions and an agent reading its own history needs both: a
     * shutdown is not something to ask about, and an interrupt from a channel
     * the agent was mid-reply to is.
     *
     * `from` is optional because a shutdown has no surface behind it — nobody
     * pressed anything. Absent means the runtime itself.
     */
    "axon:interrupt": { reason: "user" | "shutdown"; from?: string }

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

    /**
     * A reply that broke the output contract, kept verbatim.
     *
     * The correction alone was a scolding with no referent: the malformed
     * text never entered the log, so the next turn showed the model a
     * complaint about output it could no longer see. It cannot fix a shape
     * it is not looking at, and runs were observed repeating the same
     * violation immediately after being corrected for it.
     *
     * Stored raw and uninterpreted — the parser already failed on it, so any
     * structure claimed here would be a guess. It renders as the agent turn
     * it was, directly above the correction it earned.
     */
    /**
     * The model declared its turn over.
     *
     * Committed so the model can SEE its own turn endings. `<done/>` was
     * parsed as a signal and dropped, which made it the one block whose
     * correct use matters most and the only one absent from the model's own
     * record — it read the rule in the contract and never once saw itself
     * having followed it. Over a long run that is the block with the least
     * in-context reinforcement and the most consequence when it goes wrong.
     *
     * Carries no payload: the fact IS the event. A turn either ended here or
     * it did not.
     */
    "axon:agent:done": Record<string, never>

    "axon:system:malformed": {
        /** The model's output exactly as it came off the wire. */
        content: string
        /** The violation code this reply produced, matching the paired fault. */
        code: string
        /** Which engine attempt this was — 1-based, so a reader can see the sequence. */
        attempt: number
    }
}
