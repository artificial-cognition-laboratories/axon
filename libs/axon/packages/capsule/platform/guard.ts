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
const optStr = (v: unknown) => v === undefined || str(v)

/**
 * A serialized AxonError, as it arrives over the pipe — plain data, never an
 * Error instance (see the note on CapsuleEventMap). Checks the discriminant
 * and the identifying fields rather than the whole shape: the guard's job is
 * to reject garbage from a misbehaving sandbox, not to re-validate a type
 * the err() constructor already guarantees.
 */
const errJson = (v: unknown) =>
    isRecord(v) && v.isAxonError === true && str(v.code) && str(v.message)

export function isCapsuleEvent(value: unknown): value is AnyCapsuleEvent {
    if (!isRecord(value) || !str(value.type)) return false
    const v = value

    switch (v.type) {
        // ── Lifecycle ─────────────────────────────────────────────────────
        case "capsule:boot:start":
        case "capsule:ready":
        case "capsule:shutdown":
            return true
        case "capsule:boot:complete":
            return num(v.durationMs)
        case "capsule:boot:failed":
            return num(v.durationMs) && errJson(v.error)
        case "capsule:crash":
            return errJson(v.error)
        case "capsule:exit":
            return (v.code === null || num(v.code)) && optStr(v.reason)
        case "capsule:parse:error":
            return errJson(v.error) && optStr(v.line)

        // ── Supervision ───────────────────────────────────────────────────
        case "capsule:restart:start":
            return num(v.restartCount)
        case "capsule:restart:complete":
            return num(v.restartCount) && num(v.durationMs)
        case "capsule:restart:failed":
            return num(v.restartCount) && num(v.durationMs) && errJson(v.error)
        case "capsule:dead":
            return errJson(v.error)

        // ── Command execution ─────────────────────────────────────────────
        case "capsule:cmd:start":
            return str(v.id)
        case "capsule:cmd:stdout":
            return str(v.id) && str(v.data)
        case "capsule:cmd:complete":
            return str(v.id) && num(v.durationMs) && "result" in v
        case "capsule:cmd:failed":
            return str(v.id) && num(v.durationMs) && errJson(v.error)
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
            return str(v.commandId) && str(v.module) && str(v.fn) && num(v.durationMs) && errJson(v.error)

        // ── Tool loading ──────────────────────────────────────────────────
        case "capsule:tool:load:start":
            return str(v.namespace)
        case "capsule:tool:load:complete":
            return str(v.namespace) && num(v.durationMs) && Array.isArray(v.fns) && v.fns.every(str)
        case "capsule:tool:unloaded":
            return str(v.namespace)
        case "capsule:tool:load:failed":
            return str(v.namespace) && num(v.durationMs) && errJson(v.error)

        // ── Trusted host bridge ──────────────────────────────────────────
        case "capsule:host:request":
            return str(v.id) && (v.commandId === null || str(v.commandId)) && str(v.method) && "input" in v

        // ── Managed child processes ───────────────────────────────────────
        case "capsule:proc:start":
            return str(v.procId) && num(v.pid) && str(v.command) && str(v.cwd) && (v.kind === "managed" || v.kind === "run")
        case "capsule:proc:stdout":
        case "capsule:proc:stderr":
            return str(v.procId) && str(v.data)
        case "capsule:proc:complete":
            return str(v.procId) && num(v.code) && num(v.durationMs)
        case "capsule:proc:failed":
            return str(v.procId) && num(v.durationMs) && errJson(v.error)
        case "capsule:proc:denied":
            return str(v.procId) && str(v.command) && errJson(v.error)
        case "capsule:proc:stdin:error":
            return str(v.procId) && errJson(v.error)

        // ── Policy ────────────────────────────────────────────────────────
        case "capsule:policy:denied":
        case "capsule:policy:escalation":
            return str(v.id) && str(v.module) && str(v.fn) && Array.isArray(v.args) && str(v.rule)
        case "capsule:policy:decision":
            return str(v.id) && bool(v.allow) && num(v.durationMs)

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
