import type { CapsulePolicy, PolicyResponseCommand } from "./policy"

/**
 * The host → subprocess wire protocol. Commands travel as JSONL on the
 * subprocess stdin; events (types/events.ts) travel back on stdout.
 *
 * This is the complete command set. Host behavior stays outside the
 * subprocess; the generic response frame only completes calls initiated by
 * the capsule-safe Axon facade.
 */
export type CapsuleCommand =
    // ── Code execution ───────────────────────────────────────────────────────
    | { type: "cmd:run"; id: string; code: string }
    | { type: "cmd:kill"; id: string }

    // ── Policy ───────────────────────────────────────────────────────────────
    | PolicyResponseCommand
    | { type: "policy:update"; policy: CapsulePolicy }

    // ── Tools ────────────────────────────────────────────────────────────────
    | { type: "tool:load"; namespace: string; flat: boolean; source: string }
    | { type: "tool:load"; namespace: string; flat: boolean; path: string }
    | { type: "tool:unload"; namespace: string }

    // ── Trusted host bridge ─────────────────────────────────────────────────
    | { type: "host:response"; id: string; result: unknown }
    | { type: "host:response"; id: string; error: string }

    // ── Managed child processes ──────────────────────────────────────────────
    | { type: "proc:spawn"; procId: string; command: string; cwd?: string; env?: Record<string, string> }
    | { type: "proc:kill"; procId: string }
    | { type: "proc:stdin"; procId: string; data: string }

    // ── Lifecycle ────────────────────────────────────────────────────────────
    | { type: "shutdown" }

export type CapsuleCommandType = CapsuleCommand["type"]
