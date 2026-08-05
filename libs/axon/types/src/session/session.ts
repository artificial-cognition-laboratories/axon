import type { AxonEvent, AxonEventUnion } from "./envelope"
import type { AxonKernelEventMap } from "./events/kernel"
import type { AxonRuntimeEvent } from "./events/runtime"
import type { CognetEventMap } from "./events/cognet"
import type { CapsuleEventMap } from "./events/capsule"
import type { BuildEventMap } from "./events/build"
import type { AxonEntryEvent } from "./events/entries"

/**
 * A session is the agent's lifetime record — the persistent working context
 * runtimes attach to. It survives restarts; it is why an agent can be
 * restarted and still know what it was working on.
 *
 * Two responsibilities:
 * - Continuity: the one entry log, capsule attachment, summaries.
 * - Observability: the kernel/runtime telemetry firehose.
 *
 * The entry log holds the interactions (what cognition and clients see);
 * the session's own logs hold everything about how the machine ran, split
 * by audience — kernel is internal tick/phase/system telemetry (devtools,
 * flame graphs, never rendered to the user); session is the small,
 * human-relevant runtime/continuity record (boot, shutdown, errors) shown
 * alongside the entry log. First-class split in the data, not a filter a
 * consumer has to remember to apply.
 */
export type AxonSession = {
    id: string
    entries: AxonEntry[]
    events: {
        kernel: AxonKernelEvent[]
        session: AxonSessionEvent[]
    }
}

// ── Registry maps ────────────────────────────────────────────────────────────

/**
 * Everything that can appear in a session's logs (and on the runtime bus).
 * Telemetry (kernel/cognet/capsule) is durable like everything else; only
 * the capsule byte streams (CAPSULE_TRANSIENT_EVENTS) stay bus-only.
 *
 * BuildEventMap is the one family emitted with no runtime present — the
 * session is opened before the build so a failed one leaves a readable
 * record. It is in this map because it reaches the same log and must
 * satisfy the same envelope; nothing else about it is special.
 */
export type AxonEventMap = AxonKernelEventMap & AxonRuntimeEvent & CognetEventMap & CapsuleEventMap & BuildEventMap

// ── Enveloped unions (what actually sits in the JSONL) ──────────────────────

/** One line in the session's kernel log — internal telemetry, never rendered to the user. */
export type AxonKernelEvent = AxonEventUnion<AxonKernelEventMap>

/** One line in the session's own log — runtime/continuity facts. */
export type AxonSessionEvent = AxonEventUnion<AxonRuntimeEvent>

/** One line in the session's entry log. */
export type AxonEntry = AxonEventUnion<AxonEntryEvent>

/**
 * THE folding rule for the chunking standard (AxonChunk, stdio/shared.ts) —
 * the one implementation every observer applies: group entries by
 * `data.chunk.of`, in order; a group folds into ONE entry (the first
 * chunk's envelope) whose payload is the assembly of its chunks; `final`
 * closes the group. A folded entry keeps its `chunk` field so a reader can
 * see an unclosed group for what it is: a truncated emission
 * (`chunk.final !== true` after folding = interrupted mid-emission).
 *
 * Entries without `chunk` pass through untouched — self-contained complete
 * emissions, the degenerate 1-chunk case. Never mutates its input; folded
 * entries are fresh objects.
 *
 * Assembly is per information kind: text concatenates `content`;
 * ref-carrying kinds (audio/visual) concatenate their symbolic digest
 * (transcript/caption) and let later structural fields (ref, kind,
 * reading) win — the group's final state is its authoritative shape.
 */
export function foldChunks(entries: readonly AxonEntry[]): AxonEntry[] {
    const out: AxonEntry[] = []
    const open = new Map<string, AxonEntry>()

    for (const entry of entries) {
        const data = entry.data as { chunk?: { of: string; final?: boolean }; content?: string; transcript?: string; caption?: string }
        if (!data.chunk) {
            out.push(entry)
            continue
        }

        const existing = open.get(data.chunk.of)
        if (!existing) {
            const folded = { ...entry, data: { ...data } } as AxonEntry
            out.push(folded)
            if (!data.chunk.final) open.set(data.chunk.of, folded)
            continue
        }

        const target = existing.data as typeof data
        // concatenating fields accumulate; everything else the newest chunk wins
        const content = typeof target.content === "string" && typeof data.content === "string" ? target.content + data.content : undefined
        const transcript = typeof target.transcript === "string" && typeof data.transcript === "string" ? target.transcript + data.transcript : undefined
        const caption = typeof target.caption === "string" && typeof data.caption === "string" ? target.caption + data.caption : undefined
        Object.assign(target, data)
        if (content !== undefined) target.content = content
        if (transcript !== undefined) target.transcript = transcript
        if (caption !== undefined) target.caption = caption

        if (data.chunk.final) open.delete(data.chunk.of)
    }

    return out
}

/** A single enveloped kernel-log event of a specific type, e.g. AxonKernelEventOf<"kernel:tick:start">. */
export type AxonKernelEventOf<K extends keyof AxonKernelEventMap> = AxonEvent<AxonKernelEventMap, K>
/** A single enveloped session-log event of a specific type, e.g. AxonSessionEventOf<"axon:boot:complete">. */
export type AxonSessionEventOf<K extends keyof AxonRuntimeEvent> = AxonEvent<AxonRuntimeEvent, K>
export type AxonEntryOf<K extends keyof AxonEntryEvent> = AxonEvent<AxonEntryEvent, K>
