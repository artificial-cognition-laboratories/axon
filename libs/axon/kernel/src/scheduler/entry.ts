import type { AxonEntry } from "@arcforge/types"
import { ENTRY_EVENT_PREFIXES } from "@arcforge/types"

/**
 * Entry vocabulary — the families are defined WITH AxonEntryEvent, never
 * duplicated here.
 *
 * Shape-checked on `type` and `time.seq`, which is every enveloped event's
 * identity (see AxonEvent). This used to require a string `id`; when that
 * field was removed from the envelope the predicate rejected every entry
 * ever emitted, and a wake produced no output at all — a reminder that a
 * structural guard is only as correct as the shape it was written against.
 */
export function isEntry(event: unknown): event is AxonEntry {
    if (typeof event !== "object" || event === null) return false
    const e = event as { type?: string; time?: { seq?: number } }
    if (typeof e.type !== "string" || typeof e.time?.seq !== "number") return false
    return ENTRY_EVENT_PREFIXES.some(prefix => (e.type as string).startsWith(prefix))
}
