import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"
import type { AxonCancellableSpan, AxonSpan } from "./span"

/**
 * Cognet telemetry — the cognition artifact's own observability record.
 *
 * Semantically distinct from kernel:* and enforced at the seam: this map is
 * the ONLY vocabulary abi.emit accepts, so a cognet can narrate its world
 * (ticks, phases, systems, entity/component writes) but can never forge
 * kernel machinery events (run records, engine calls).
 *
 * Fire-and-forget for the cognet, durable in the machine: abi.emit commits
 * these to the session's log (telemetry view, alongside kernel:*) and the
 * commit pipeline forwards them to the bus — flame-graph and devtools
 * material, never rendered to the user. At some level cognet events have
 * to reach a log for the brain to be debuggable; this is that level. The
 * durable record around a wake (kernel:run:*) remains the kernel's and
 * only the kernel's.
 *
 * The world clock lives HERE, not in kernel:* — since cognition moved into
 * the cognet layer, ticks and phases are the program's own clock; the
 * kernel neither knows nor cares that a program ticks.
 */
export type CognetEventMap =
    & AxonLogEvents<"cognet">
    // ── Artifact lifecycle ───────────────────────────────────────────────────
    //
    // Emitted by the KERNEL, not by the cognet — deliberately the one family
    // in this map the brain does not produce. exec'ing an untrusted artifact
    // is the most failure-prone step in boot, and a cognet that dies inside
    // load() cannot narrate its own failure: whatever bracket it opened would
    // never close. The kernel is the only loader (see Kernel()), so it is the
    // only thing positioned to record both halves honestly.
    & AxonSpan<"cognet:load", { name: string }, { name: string }, { name: string; error: AxonError }>
    & AxonSpan<"cognet:unload", { name: string }, { name: string }, { name: string; error: AxonError }>
    // ── World clock ──────────────────────────────────────────────────────────
    //
    // Three nested levels, each the four-state form: a tick contains phases,
    // a phase contains systems. :interrupted at every level means the wake
    // was cancelled (Escape/Ctrl+C, engine abort) — cancellation, not a bug,
    // kept distinct from :failed so devtools never conflate the two.
    //
    // The bracket identity is in the payload (tick number, phase name,
    // system name), which is what lets a reader pair a start with its own
    // end when siblings of the same stem appear in one run.
    & AxonCancellableSpan<
        "cognet:tick",
        { tick: number },
        { tick: number },
        { tick: number; error: AxonError },
        { tick: number }
    >
    & AxonCancellableSpan<
        "cognet:phase",
        { tick: number; phase: string },
        { tick: number; phase: string },
        { tick: number; phase: string; error: AxonError },
        { tick: number; phase: string }
    >
    & AxonCancellableSpan<
        "cognet:system",
        { tick: number; phase: string | null; system: string },
        { tick: number; phase: string | null; system: string },
        { tick: number; phase: string | null; system: string; error: AxonError },
        { tick: number; phase: string | null; system: string }
    >
    & {
    // ── Knowledge mutations ──────────────────────────────────────────────────
    //
    // Emitted by the KERNEL when a cognet writes or removes long-term
    // knowledge — the cognet never records its own mutations, the same rule
    // that governs run()'s action/result pair.
    //
    // Not a span: a write is a settled act, not a bracket. There is no
    // meaningful "in progress" for an atomic temp+rename, so :start/:complete
    // would be two lines describing one instant.
    //
    // Traced because "the agent modified its own long-term memory" is exactly
    // the fact you want when behaviour drifts weeks later. Name only, never
    // content — the log records that memory changed, not a second copy of it.
    "cognet:knowledge:write": { name: string }
    "cognet:knowledge:remove": { name: string }

    // ── World writes ─────────────────────────────────────────────────────────
    "cognet:entity:add": { tick: number; phase: string | null; entity: string }
    "cognet:entity:remove": { tick: number; phase: string | null; entity: string }

    "cognet:component:add": { tick: number; phase: string | null; entity: string; component: string }
    "cognet:component:update": { tick: number; phase: string | null; entity: string; component: string }
    "cognet:component:remove": { tick: number; phase: string | null; entity: string; component: string }
}
