/**
 * CapsuleEventMap — everything the capsule can emit. The capsule package's
 * own vocabulary (its subprocess bus serializes these over stdout as JSONL;
 * the host wire validates and re-emits them), registered HERE because every
 * event type that can reach a session log lives in this package's registry
 * — @axon/capsule re-exports it (types/events.ts), it does not own it.
 *
 * Naming: start/complete/failed verb suffixes throughout, matching the
 * kernel/cognet conventions — capsule spans (cmd, fn, proc) pair up in a
 * flame graph exactly like kernel:run/cognet:tick do.
 *
 * Durability: committed to the session log (telemetry view) by the
 * kernel's AxonCapsule forwarder — EXCEPT the byte streams named in
 * CAPSULE_TRANSIENT_EVENTS below, which stay bus-only: heavy payloads
 * never enter the log (envelope rule 2), and a command's stdout already
 * reaches the durable record as cognet:action:result's folded content.
 *
 * capsule:attach/detach (runtime.ts) are not here — same namespace, but
 * they're the runtime's continuity facts about attachment, committed at
 * the runtime's lifecycle seams; this map is what the capsule itself emits.
 */
import type { Activity } from "./activity"

export type CapsuleEventMap = {
    // ── Lifecycle ────────────────────────────────────────────────────────────
    "capsule:boot:start": {}
    "capsule:boot:complete": { durationMs: number }
    "capsule:boot:failed": { durationMs: number; error: string }
    "capsule:ready": {}
    "capsule:shutdown": {}
    /** Unhandled error inside the subprocess. Exit usually follows. */
    "capsule:crash": { error: string }
    /** The capsule subprocess itself exited (not a managed child process). */
    "capsule:exit": { code: number | null; reason?: string }
    /** A wire line failed to parse — the sandbox is speaking garbage. Never dropped silently. */
    "capsule:parse:error": { reason: string; line?: string }

    // ── Supervision (host-side) ──────────────────────────────────────────────
    "capsule:restarting": { restartCount: number }
    "capsule:restarted": { restartCount: number }
    "capsule:dead": { reason: string }

    // ── Command execution (one run() = one command id) ──────────────────────
    "capsule:cmd:start": { id: string }
    "capsule:cmd:stdout": { id: string; data: string }
    "capsule:cmd:complete": { id: string; result: unknown; durationMs: number }
    "capsule:cmd:failed": { id: string; error: string; durationMs: number }
    "capsule:cmd:interrupt:requested": { id: string; reason: "abort" | "timeout" }
    "capsule:cmd:interrupted": { id: string; durationMs: number }
    "capsule:cmd:hard-killed": { id: string; graceMs: number }

    // ── Tool call spans (mediated fn calls inside a command) ────────────────
    "capsule:fn:start": { commandId: string; module: string; fn: string; args: unknown[] }
    "capsule:fn:complete": { commandId: string; module: string; fn: string; durationMs: number; result: unknown }
    "capsule:fn:failed": { commandId: string; module: string; fn: string; durationMs: number; error: string }

    // ── Tool loading ─────────────────────────────────────────────────────────
    "capsule:tool:loaded": { namespace: string; fns: string[] }
    "capsule:tool:unloaded": { namespace: string }
    "capsule:tool:error": { namespace: string; error: string }

    // ── Trusted host bridge ─────────────────────────────────────────────────
    /** Private request transport for the capsule Axon facade. Never durable. */
    "capsule:host:request": { id: string; commandId: string | null; method: string; input: unknown }

    // ── Managed child processes ──────────────────────────────────────────────
    "capsule:proc:spawned": { procId: string; pid: number; command: string; cwd: string; kind: "managed" | "run" }
    "capsule:proc:stdout": { procId: string; data: string }
    "capsule:proc:stderr": { procId: string; data: string }
    "capsule:proc:exit": { procId: string; code: number; durationMs?: number }
    "capsule:proc:denied": { procId: string; command: string; error: string }
    "capsule:proc:stdin:error": { procId: string; error: string }

    // ── Policy ───────────────────────────────────────────────────────────────
    "capsule:policy:updated": {}
    "capsule:policy:denied": { id: string; module: string; fn: string; args: unknown[]; rule: string }
    "capsule:policy:escalation": { id: string; module: string; fn: string; args: unknown[]; rule: string }
    /** Host-side: the escalate callback's verdict for a pending escalation. */
    "capsule:policy:decision": { id: string; allow: boolean; durationMs: number }
    "capsule:resource:exceeded": { id: string; limit: string; value: number; max: number }

    // ── Activities (semantic tool emissions) ─────────────────────────────────
    /**
     * A tool declared or settled a renderable activity (activity.ts) via the
     * ambient axon.activity(). Correlated to the running command the same way
     * capsule:console is; null only if emitted outside any command.
     */
    "capsule:activity": Activity & { commandId: string | null }

    // ── Console + state ──────────────────────────────────────────────────────
    /** User console output, captured — correlated to the running command, never raw on stdout. */
    "capsule:console": { level: "log" | "info" | "warn" | "error" | "debug"; commandId: string | null; args: unknown[] }
    "capsule:cwd": { cwd: string }
}

export type CapsuleEventName = keyof CapsuleEventMap

/** One event as it travels the wire and the buses: { type } + payload, flat. */
export type AnyCapsuleEvent = {
    [K in CapsuleEventName]: { type: K } & CapsuleEventMap[K]
}[CapsuleEventName]

/**
 * The byte streams — live wire material, never committed. Everything not
 * in this set is durable. The one canonical list; the kernel's forwarder
 * derives its split from here, never from its own type sniff.
 */
export const CAPSULE_TRANSIENT_EVENTS = new Set<CapsuleEventName>([
    "capsule:cmd:stdout",
    "capsule:proc:stdout",
    "capsule:proc:stderr",
    "capsule:console",
    "capsule:host:request",
])
