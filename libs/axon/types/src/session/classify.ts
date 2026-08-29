import { ENTRY_EVENT_PREFIXES } from "./events/entries"

/**
 * Which of a session's three views an event belongs to.
 *
 * These predicates are the single definition. They lived as locals inside
 * core's Session() while the TUI kept its own prefix sniff and the wake
 * scheduler kept a third — three copies of one rule, which is exactly how a
 * classification drifts. Anything routing an event into entries / kernelLog /
 * log derives from here, on either side of the wire.
 */

/**
 * Internal machinery telemetry — devtools/flame-graph material, never a
 * runtime/continuity fact. kernel:* is the machinery's own record; cognet:* is
 * the brain narrating its world; process:* is the agent's own execution stream.
 *
 * Two carve-outs: entry families under cognet:* are entries, not telemetry (so
 * isEntryEvent is checked first by classifyEvent), and process:attach/detach are
 * the runtime's continuity facts — same namespace, different role — which
 * hydration and humans read from the session view.
 *
 * ── `capsule:` is still accepted, and must stay that way ────────────────────
 *
 * The prefix was renamed when the agent itself became the process: "capsule"
 * named a sandbox subprocess that no longer describes anything. But session
 * logs are DURABLE — a `.jsonl` written last week still carries the old names,
 * and every reader here (the flame graph, the process tree, readSession)
 * matches on these literals. Dropping the old prefix would not break a test;
 * it would silently make historical sessions render as empty timelines.
 *
 * So this reads both and emitters write only the new one. The compatibility
 * arm can go once no log anyone cares about predates the rename.
 */
export function isKernelEvent(type: string): boolean {
    if (type === "process:attach" || type === "process:detach") return false
    if (type === "process:attach" || type === "process:detach") return false
    return type.startsWith("kernel:")
        || type.startsWith("cognet:")
        || type.startsWith("process:")
        || type.startsWith("capsule:")
}

/** An interaction — what cognition and clients see. Derived from the canonical prefix list. */
export function isEntryEvent(type: string): boolean {
    return ENTRY_EVENT_PREFIXES.some(prefix => type.startsWith(prefix))
}

/** The three session views an event can land in. */
export type AxonEventView = "entries" | "kernelLog" | "log"

/**
 * Route one event type to its view. Order matters: entry families live under
 * cognet:*, so the entry check must come before the kernel check or every
 * stimulus/output would be misfiled as telemetry.
 */
export function classifyEvent(type: string): AxonEventView {
    if (isEntryEvent(type)) return "entries"
    if (isKernelEvent(type)) return "kernelLog"
    return "log"
}
