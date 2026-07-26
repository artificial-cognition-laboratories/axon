import type { AnyCapsuleEvent } from "../types"

/**
 * Wire-side validation for inbound events — generated against the
 * CapsuleEvent map in types/events.ts. If an event type is added to the map,
 * it must be added here; the wire drops anything unrecognized as a
 * capsule:parse:error, so a missing case fails loudly in dev.
 */

type UnknownRecord = Record<string, unknown>

function isRecord(v: unknown): v is UnknownRecord {
    return v !== null && typeof v === "object" && !Array.isArray(v)
}

const str = (v: unknown) => typeof v === "string"
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
const bool = (v: unknown) => typeof v === "boolean"
const optNum = (v: unknown) => v === undefined || num(v)
const optStr = (v: unknown) => v === undefined || str(v)

export function isCapsuleEvent(value: unknown): value is AnyCapsuleEvent {
    if (!isRecord(value) || !str(value.type)) return false
    const v = value

    switch (v.type) {
        // ── Lifecycle ─────────────────────────────────────────────────────
        case "capsule:boot:start":
        case "capsule:ready":
        case "capsule:shutdown":
        case "capsule:policy:updated":
            return true
        case "capsule:boot:complete":
            return num(v.durationMs)
        case "capsule:boot:failed":
            return num(v.durationMs) && str(v.error)
        case "capsule:crash":
            return str(v.error)
        case "capsule:exit":
            return (v.code === null || num(v.code)) && optStr(v.reason)
        case "capsule:parse:error":
            return str(v.reason) && optStr(v.line)

        // ── Supervision ───────────────────────────────────────────────────
        case "capsule:restarting":
        case "capsule:restarted":
            return num(v.restartCount)
        case "capsule:dead":
            return str(v.reason)

        // ── Command execution ─────────────────────────────────────────────
        case "capsule:cmd:start":
            return str(v.id)
        case "capsule:cmd:stdout":
            return str(v.id) && str(v.data)
        case "capsule:cmd:complete":
            return str(v.id) && num(v.durationMs) && "result" in v
        case "capsule:cmd:failed":
            return str(v.id) && num(v.durationMs) && str(v.error)
        case "capsule:cmd:interrupt:requested":
            return str(v.id) && (v.reason === "abort" || v.reason === "timeout")
        case "capsule:cmd:interrupted":
            return str(v.id) && num(v.durationMs)
        case "capsule:cmd:hard-killed":
            return str(v.id) && num(v.graceMs)

        // ── Tool call spans ───────────────────────────────────────────────
        case "capsule:fn:start":
            return str(v.commandId) && str(v.module) && str(v.fn) && Array.isArray(v.args)
        case "capsule:fn:complete":
            return str(v.commandId) && str(v.module) && str(v.fn) && num(v.durationMs) && "result" in v
        case "capsule:fn:failed":
            return str(v.commandId) && str(v.module) && str(v.fn) && num(v.durationMs) && str(v.error)

        // ── Tool loading ──────────────────────────────────────────────────
        case "capsule:tool:loaded":
            return str(v.namespace) && Array.isArray(v.fns) && v.fns.every(str)
        case "capsule:tool:unloaded":
            return str(v.namespace)
        case "capsule:tool:error":
            return str(v.namespace) && str(v.error)

        // ── Trusted host bridge ──────────────────────────────────────────
        case "capsule:host:request":
            return str(v.id) && (v.commandId === null || str(v.commandId)) && str(v.method) && "input" in v

        // ── Managed child processes ───────────────────────────────────────
        case "capsule:proc:spawned":
            return str(v.procId) && num(v.pid) && str(v.command) && str(v.cwd) && (v.kind === "managed" || v.kind === "run")
        case "capsule:proc:stdout":
        case "capsule:proc:stderr":
            return str(v.procId) && str(v.data)
        case "capsule:proc:exit":
            return str(v.procId) && num(v.code) && optNum(v.durationMs)
        case "capsule:proc:denied":
            return str(v.procId) && str(v.command) && str(v.error)
        case "capsule:proc:stdin:error":
            return str(v.procId) && str(v.error)

        // ── Policy ────────────────────────────────────────────────────────
        case "capsule:policy:denied":
        case "capsule:policy:escalation":
            return str(v.id) && str(v.module) && str(v.fn) && Array.isArray(v.args) && str(v.rule)
        case "capsule:policy:decision":
            return str(v.id) && bool(v.allow) && num(v.durationMs)
        case "capsule:resource:exceeded":
            return str(v.id) && str(v.limit) && num(v.value) && num(v.max)

        // ── Activities ────────────────────────────────────────────────────
        case "capsule:activity":
            return (
                str(v.id) && str(v.activity) &&
                (v.phase === "declared" || v.phase === "done" || v.phase === "failed") &&
                (v.commandId === null || str(v.commandId)) &&
                isRecord(v.data) && optStr(v.error)
            )

        // ── Console + state ───────────────────────────────────────────────
        case "capsule:console":
            return (
                (v.level === "log" || v.level === "info" || v.level === "warn" ||
                 v.level === "error" || v.level === "debug") &&
                (v.commandId === null || str(v.commandId)) &&
                Array.isArray(v.args)
            )
        case "capsule:cwd":
            return str(v.cwd)

        default:
            return false
    }
}
