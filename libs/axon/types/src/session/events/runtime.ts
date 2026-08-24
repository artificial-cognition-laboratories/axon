import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"
import type { AxonSpan } from "./span"

/**
 * Runtime + continuity events — the session's own lifecycle record.
 *
 * Two families in one map:
 * - Runtime facts (boot/shutdown/reload/server): "a runtime attached to this
 *   session and did things". A session can span many boots.
 * - Continuity facts (session/capsule): the small, load-bearing subset
 *   hydration reads on resume.
 *
 * No single prefix covers this map (boot:/shutdown:/session:/capsule:/
 * server:), so its log events use "runtime" as the namespace —
 * axon:log:info/warning/error — rather than picking one arbitrary
 * existing prefix to own logging for the whole map.
 *
 * axon:log:* is a distinct namespace within this same map: console output
 * captured from agent-authored code (boot.vue today; the CLI config layer
 * once it's wired to a session too). "axon" names the runtime the user's
 * own code is running inside — not any one lifecycle prefix above — so it
 * gets its own namespace rather than folding into axon:log:*.
 */
export type AxonRuntimeEvent =
    & AxonLogEvents<"axon">
    // ── Runtime lifecycle ────────────────────────────────────────────────────
    & AxonSpan<"axon:boot", { version: string; agentRoot: string; mode: "local" | "cloud" }>
    & AxonSpan<"axon:shutdown", { reason?: string }>
    // ── Surface reload (blueprint/tools changed under a live runtime) ───────
    & AxonSpan<
        "axon:reload",
        { revision: number },
        { revision: number; toolCount: number },
        { revision?: number; error: AxonError }
    >
    // ── Module install/uninstall (registry op, then a reload rides the same
    //    hot-swap path above) ─────────────────────────────────────────────
    & AxonSpan<
        "axon:install",
        { name: string; version?: string },
        { name: string; version: string; alreadyInstalled: boolean },
        { name: string; version?: string; error: AxonError }
    >
    & {
        /**
         * No module by that name in the registry — a typo or an unpublished
         * package. A settled outcome, not a failure: nothing broke, so it must
         * not render as an error. Distinct from :failed, which means the
         * install itself went wrong (network, disk, a bad tarball).
         *
         * Outside the span triad by design — a third settled outcome, the
         * same way :interrupted is for cancellable operations.
         */
        "axon:install:not-found": { name: string; durationMs: number }
    }
    & AxonSpan<
        "axon:uninstall",
        { name: string },
        { name: string },
        { name: string; error: AxonError }
    >
    // ── Model change (config edit, then a reload rides the hot-swap path) ───
    //    The agent is the same agent; only the engine underneath it moved.
    //    `dropped` names options the previous provider had that the new one
    //    does not accept (e.g. Codex's `effort`), so the change is never a
    //    silent loss of the author's configuration.
    & AxonSpan<
        "axon:model",
        { name: string },
        { name: string; changed: boolean; dropped: string[] },
        { name: string; error: AxonError }
    >
    // ── Module setup/teardown (boot-time defineModule() setup execution) ─────
    //    The determinism ledger: one start/complete (or failed) per module,
    //    in blueprint order, carrying the config content hash so two boots of
    //    the same blueprint are provably the same wiring.
    & AxonSpan<
        "module:setup",
        { name: string; configHash: string; options: Record<string, unknown> },
        { name: string },
        { name: string; error: AxonError }
    >
    & AxonSpan<
        "module:dispose",
        { name: string },
        { name: string },
        { name: string; error: AxonError }
    >
    & {
    // ── Session continuity ───────────────────────────────────────────────────
    //    NOT a span, and deliberately not named like one. A session outlives
    //    the runtime that opened it: `opened` and `closed` can be days and
    //    several processes apart, with any number of boots in between, so
    //    there is no bracket here for a reader to match or a flame graph to
    //    draw. `axon:session:start` collided with the span vocabulary and
    //    read as a bracket that never closed — these verbs keep the
    //    continuity family honestly outside it.
    "axon:session:opened": {}
    "axon:session:restored": {}
    "axon:session:closed": {}

    // ── Capsule attachment (one capsule per session; telemetry lives in the capsule package) ──
    "capsule:attach": { capsuleId: string; cwd: string }
    "capsule:detach": { capsuleId: string; reason: "shutdown" | "crash" | "reload" }

    // ── Server ───────────────────────────────────────────────────────────────
    "axon:server:request": { method: string; path: string; status: number; durationMs: number }

    // ── Errors ───────────────────────────────────────────────────────────────
    "axon:error": { event?: string; error: AxonError }
    /**
     * A bus handler threw. "axon" names the runtime layer the failure
     * happened in, not any one lifecycle prefix above.
     *
     * Carries the full AxonError (envelope rule 4) — plugins and modules
     * register handlers, so a stringified message would drop the stack at
     * exactly the boundary where "which plugin broke?" is the only question
     * worth answering.
     */
    "axon:bus:error": { event: string; error: AxonError }
}
