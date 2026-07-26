import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"

/**
 * Runtime + continuity events — the session's own lifecycle record.
 *
 * Two families in one map:
 * - Runtime facts (boot/shutdown/reload/server): "a runtime attached to this
 *   session and did things". A session can span many boots.
 * - Continuity facts (session/capsule/compress): the small, load-bearing
 *   subset hydration reads on resume.
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
export type AxonRuntimeEvent = AxonLogEvents<"axon"> & {
    // ── Runtime lifecycle ────────────────────────────────────────────────────
    "axon:boot:start": { version: string; agentRoot: string; mode: "local" | "cloud" }
    "axon:boot:complete": { durationMs: number }
    "axon:boot:failed": { error: AxonError }

    "axon:shutdown:start": { reason?: string }
    "axon:shutdown:complete": { durationMs: number }
    "axon:shutdown:failed": { error: AxonError }

    // ── Surface reload (blueprint/tools changed under a live runtime) ───────
    "axon:reload:start": { revision: number }
    "axon:reload:complete": { revision: number; durationMs: number; toolCount: number }
    "axon:reload:failed": { revision?: number; error: AxonError }

    // ── Module install/uninstall (registry op, then a reload rides the same
    //    hot-swap path above) ─────────────────────────────────────────────
    "axon:install:start": { name: string; version?: string }
    "axon:install:complete": { name: string; version: string; durationMs: number; alreadyInstalled: boolean }
    /**
     * No module by that name in the registry — a typo or an unpublished
     * package. A settled outcome, not a failure: nothing broke, so it must
     * not render as an error. Distinct from :failed, which means the
     * install itself went wrong (network, disk, a bad tarball).
     */
    "axon:install:not-found": { name: string; durationMs: number }
    "axon:install:failed": { name: string; version?: string; error: AxonError }

    "axon:uninstall:start": { name: string }
    "axon:uninstall:complete": { name: string; durationMs: number }
    "axon:uninstall:failed": { name: string; error: AxonError }

    // ── Module setup/teardown (boot-time defineModule() setup execution) ─────
    //    The determinism ledger: one start/complete (or failed) per module,
    //    in blueprint order, carrying the config content hash so two boots of
    //    the same blueprint are provably the same wiring.
    "module:setup:start": { name: string; configHash: string; options: Record<string, unknown> }
    "module:setup:complete": { name: string; durationMs: number }
    "module:setup:failed": { name: string; error: AxonError }
    "module:dispose:start": { name: string }
    "module:dispose:complete": { name: string; durationMs: number }
    "module:dispose:failed": { name: string; error: AxonError }

    // ── Session continuity ───────────────────────────────────────────────────
    "axon:session:start": {}
    "axon:session:restored": {}
    "axon:session:end": {}
    "axon:session:error": { error: AxonError }

    // ── Capsule attachment (one capsule per session; telemetry lives in the capsule package) ──
    "capsule:attach": { capsuleId: string; cwd: string }
    "capsule:detach": { capsuleId: string; reason: "shutdown" | "crash" | "reload" }

    // ── Compression — summaries replacing aged entries ──────────────────────
    "axon:compress": { replaced: number; summaryEntryId: string }

    // ── Server ───────────────────────────────────────────────────────────────
    "axon:server:request": { method: string; path: string; status: number; durationMs: number }

    // ── Errors ───────────────────────────────────────────────────────────────
    "axon:error": { event?: string; error: AxonError }
    /** Matches the literal string the bus actually emits (platform/bus.ts) — "axon" names the runtime layer the failure happened in, not any one lifecycle prefix above. */
    "axon:bus:error": { event: string; error: string }
}
