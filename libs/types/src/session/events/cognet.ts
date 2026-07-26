import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"

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
export type CognetEventMap = AxonLogEvents<"cognet"> & {
    // ── World clock ──────────────────────────────────────────────────────────
    "cognet:tick:start": { tick: number }
    "cognet:tick:complete": { tick: number }
    "cognet:tick:failed": { tick: number; error: AxonError }
    /** The tick's own work threw because the wake was interrupted (Escape/Ctrl+C, engine abort) — cancellation, not a bug. Distinct from :failed so devtools/telemetry never conflate the two. */
    "cognet:tick:interrupted": { tick: number }

    "cognet:phase:start": { tick: number; phase: string }
    "cognet:phase:complete": { tick: number; phase: string }
    "cognet:phase:failed": { tick: number; phase: string; error: AxonError }
    /** Same rule as cognet:tick:interrupted, one level down. */
    "cognet:phase:interrupted": { tick: number; phase: string }

    "cognet:system:start": { tick: number; phase: string | null; system: string }
    "cognet:system:complete": { tick: number; phase: string | null; system: string; durationMs: number }
    "cognet:system:failed": { tick: number; phase: string | null; system: string; error: AxonError }
    /** Same rule as cognet:tick:interrupted, one level down. */
    "cognet:system:interrupted": { tick: number; phase: string | null; system: string }

    // ── World writes ─────────────────────────────────────────────────────────
    "cognet:entity:add": { tick: number; phase: string | null; entity: string }
    "cognet:entity:remove": { tick: number; phase: string | null; entity: string }

    "cognet:component:add": { tick: number; phase: string | null; entity: string; component: string }
    "cognet:component:update": { tick: number; phase: string | null; entity: string; component: string }
    "cognet:component:remove": { tick: number; phase: string | null; entity: string; component: string }
}
