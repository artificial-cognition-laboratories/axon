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
import type { AxonErrorJSON } from "../../error"
import type { AxonCancellableSpan, AxonSpan } from "./span"
import type { CapsuleScope } from "../../capsule-scope"

/**
 * Capsule failures carry AxonErrorJSON, not AxonError.
 *
 * Everywhere else in the system a :failed payload is a live AxonError, and
 * JSON.stringify's toJSON() handles serialization on the way to disk. The
 * capsule is the one boundary where that is a lie: these events are
 * constructed inside a SUBPROCESS and cross a JSONL pipe, so what the host
 * receives is already plain data — a parsed object with isAxonError: true,
 * never an Error instance. Typing it as AxonError would promise a .render()
 * and a live .cause chain that do not survive the pipe.
 *
 * The full structured value still crosses: code, title, description,
 * captured frames with source snippets, and the cause chain. Only the
 * behavior is lost, which is exactly what the JSON shape describes.
 */

/**
 * Who asked for a capsule command to run — see the capsule:cmd span below.
 *
 * Declared here rather than in @axon/capsule for the same reason the event
 * map is: every type that can reach a session log lives in this package's
 * registry, and @axon/capsule re-exports from here rather than owning it.
 */
export type CapsuleCommandOrigin = "cognet" | "host"

export type CapsuleEventMap =
    // ── Lifecycle ────────────────────────────────────────────────────────────
    & AxonSpan<"capsule:boot", {}, {}, { error: AxonErrorJSON }>
    & {
        "capsule:ready": {}
        "capsule:shutdown": {}
        /** Unhandled error inside the subprocess. Exit usually follows. */
        "capsule:crash": { error: AxonErrorJSON }
        /** The capsule subprocess itself exited (not a managed child process). */
        "capsule:exit": { code: number | null; reason?: string }
        /** A wire line failed to parse — the sandbox is speaking garbage. Never dropped silently. */
        "capsule:parse:error": { error: AxonErrorJSON; line?: string }

        /**
         * Supervision gave up — the capsule is gone and will not come back on
         * its own. Terminal, and deliberately NOT capsule:restart:failed: it
         * also fires when the restart budget is exhausted, which is a
         * supervision verdict rather than one restart going wrong.
         */
        "capsule:dead": { error: AxonErrorJSON }
    }
    // ── Supervision (host-side) — one crash-and-recover cycle ───────────────
    & AxonSpan<
        "capsule:restart",
        { restartCount: number },
        { restartCount: number },
        { restartCount: number; error: AxonErrorJSON }
    >
    // ── Command execution (one run() = one command id) ──────────────────────
    //    `origin` is provenance, never privilege: a "host" command (a
    //    developer typing into Fleet's capsule input) travels the identical
    //    path under the identical policy gate as the cognet's own code. It
    //    is recorded because this log is a record of what the AGENT did,
    //    and an unmarked human command would make that record lie.
    //    Absent means "cognet" — every command predating this field, and
    //    every command the runtime itself issues.
    & AxonCancellableSpan<
        "capsule:cmd",
        { id: string; origin?: CapsuleCommandOrigin },
        { id: string; result: unknown; scope: CapsuleScope },
        { id: string; error: AxonErrorJSON },
        { id: string; durationMs: number }
    >
    & {
        "capsule:cmd:stdout": { id: string; data: string }
        "capsule:cmd:interrupt:requested": { id: string; reason: "abort" | "timeout" }
        "capsule:cmd:hard-killed": { id: string; graceMs: number }
    }
    // ── Tool call spans (mediated fn calls inside a command) ────────────────
    & AxonSpan<
        "capsule:fn",
        { commandId: string; module: string; fn: string; args: unknown[] },
        { commandId: string; module: string; fn: string; result: unknown },
        { commandId: string; module: string; fn: string; error: AxonErrorJSON }
    >
    // ── Tool loading ─────────────────────────────────────────────────────────
    //    A dynamic import inside the sandbox: genuinely bracketed, and slow
    //    or hanging often enough that the :start half earns its place.
    & AxonSpan<
        "capsule:tool:load",
        { namespace: string },
        { namespace: string; fns: string[] },
        { namespace: string; error: AxonErrorJSON }
    >
    // ── Managed child processes ──────────────────────────────────────────────
    //    One spawned process = one span. A non-zero exit is NOT :failed — the
    //    process ran exactly as asked and returned a code, which is ordinary
    //    and lives in the payload. :failed is reserved for the span itself
    //    breaking (the child could not be reaped, the handle was lost), which
    //    is why its payload carries no exit code: there isn't one.
    & AxonSpan<
        "capsule:proc",
        { procId: string; pid: number; command: string; cwd: string; kind: "managed" | "run" },
        { procId: string; code: number },
        { procId: string; error: AxonErrorJSON }
    >
    & {
        /**
         * Unloading is a synchronous map delete — a settled fact with no
         * interior, so it stays a bare event rather than a one-tick span.
         */
        "capsule:tool:unloaded": { namespace: string }

        // ── Trusted host bridge ──────────────────────────────────────────────
        /** Private request transport for the capsule Axon facade. Never durable. */
        "capsule:host:request": { id: string; commandId: string | null; method: string; input: unknown }

        // ── Child process byte streams ───────────────────────────────────────
        "capsule:proc:stdout": { procId: string; data: string }
        "capsule:proc:stderr": { procId: string; data: string }
        /**
         * A process the sandbox asked for was never created — refused by
         * policy, killed before it could spawn, or the spawn itself failed.
         * Outside the span triad on purpose: nothing started, so there is no
         * bracket to close. Same rule as capsule:fn, which opens only once
         * policy admits the call.
         */
        "capsule:proc:denied": { procId: string; command: string; error: AxonErrorJSON }
        "capsule:proc:stdin:error": { procId: string; error: AxonErrorJSON }

        // ── Policy ───────────────────────────────────────────────────────────
        "capsule:policy:denied": { id: string; module: string; fn: string; args: unknown[]; rule: string }
        "capsule:policy:escalation": { id: string; module: string; fn: string; args: unknown[]; rule: string }
        /** Host-side: the escalate callback's verdict for a pending escalation. */
        "capsule:policy:decision": { id: string; allow: boolean; durationMs: number }

        // ── Activities (semantic tool emissions) ─────────────────────────────
        /**
         * A tool declared or settled a renderable activity (activity.ts) via
         * the ambient axon.activity(). Correlated to the running command the
         * same way capsule:console is; null only if emitted outside any command.
         */
        "capsule:activity": Activity & { commandId: string | null }

        // ── Console + state ──────────────────────────────────────────────────
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
