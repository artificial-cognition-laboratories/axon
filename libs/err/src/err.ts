import { errorMap, type AxonErrorCode, type AxonErrorMap } from "./map"
import { captureStack, firstRealFrame } from "./stack"
import { renderError } from "./render"
import { emitError } from "./sink"
import type { AxonError, AxonErrorContext, AxonErrorJSON, AxonErrorSeverity, AxonStackFrame } from "@arcforge/types"

// AxonError and its data shapes are the wire contract — they live in
// @arcforge/types. err() below is their runtime implementation. Re-exported
// so existing `import { AxonError } from "@axon/err"` call sites keep working.
export type { AxonError, AxonErrorContext, AxonErrorJSON } from "@arcforge/types"

/** Everything optional about a single err() call, collapsed into one object — one call shape, no positional slots to skip with `undefined`. */
export type AxonErrorOpts = {
    /** The specific instance of this failure ("prompt \"greeting\" not found", not just "Prompt Not Found"). Omit when the map's title already says everything there is to say — render() only prints a message line when detail adds information the title doesn't already carry. */
    detail?: string
    context?: AxonErrorContext
    severity?: AxonErrorSeverity
    cause?: unknown
}

/** Narrow an unknown catch value to an AxonError. */
export function isAxonError(value: unknown): value is AxonError {
    return value instanceof Error && (value as AxonError).isAxonError === true
}

/**
 * One constructor, one call shape, every failure site:
 *
 *   err("PROMPT_NOT_FOUND", { context: { name } })   — you know exactly what this is; the map's identity contract applies
 *   err(cause)                                        — a catch boundary caught something uninspected
 *
 * The second form is not an escape hatch around the map — it resolves to
 * the map's own "UNKNOWN" entry, which exists for exactly this and is
 * fully visible in the log (AX-UNKNOWN-001) same as any declared code. An
 * already-constructed AxonError passed to the second form comes back
 * untouched (re-wrapping a rethrow must never lose the original identity
 * or stack) — and, since it already emitted once at its original throw
 * site, is NOT re-emitted here.
 *
 * Transport: every fresh construction calls emitError(), which delivers to
 * the current AsyncLocalStorage scope's sink (see sink.ts errScope) — the
 * runtime establishes that scope at its well-defined entry points, so the
 * error reaches THAT runtime's session and no other. This is the ONLY place
 * emission fires — a catch boundary must never re-commit an error under its
 * own event type; it rethrows, or if it must record lifecycle bookkeeping
 * (a run "failed" vs "completed"), that record carries no error payload of
 * its own. One error, one emission, one canonical "error" session event
 * downstream.
 */
export function err(code: AxonErrorCode, opts?: AxonErrorOpts): AxonError
export function err(cause: unknown): AxonError
export function err(codeOrCause: AxonErrorCode | unknown, opts?: AxonErrorOpts): AxonError {
    if (isAxonError(codeOrCause)) return codeOrCause
    if (typeof codeOrCause !== "string" || !(codeOrCause in errorMap)) {
        return fromUnknown(codeOrCause)
    }

    const code = codeOrCause as AxonErrorCode
    const def = (errorMap as AxonErrorMap)[code]

    const e = new Error(opts?.detail ?? def.title, { cause: opts?.cause }) as AxonError

    e.code = def.code
    e.title = def.title
    e.description = def.description
    e.source = def.source
    e.severity = opts?.severity ?? def.severity
    e.context = opts?.context
    e.frames = captureStack(2) // drop captureStack's own frame + err()'s
    e.isAxonError = true

    e.render = () => renderError(e)
    e.toJSON = () => ({
        isAxonError: true,
        code: e.code,
        title: e.title,
        description: e.description,
        message: e.message,
        source: e.source,
        severity: e.severity,
        ...(e.context !== undefined ? { context: toJsonSafe(e.context) } : {}),
        frames: e.frames,
        ...(e.stack !== undefined ? { stack: e.stack } : {}),
        ...(e.cause !== undefined ? { cause: causeToJSON(e.cause) } : {}),
    })

    emitError(e)
    return e
}

/** The UNKNOWN path — a caught value that never went through err() at its origin. Still fully renderable, still logged, just honestly marked as unclassified. */
function fromUnknown(value: unknown): AxonError {
    const message = value instanceof Error ? value.message : String(value)
    const wrapped = err("UNKNOWN", { detail: message, cause: value, severity: "fatal" })
    if (value instanceof Error && value.stack) wrapped.stack = value.stack
    return wrapped
}

/**
 * Context is caller-supplied and not guaranteed JSON-safe (circular
 * references, non-plain objects) — but toJSON()'s output gets serialized
 * automatically (session append, bus relay), far from this call site.
 * Guaranteeing safety HERE, at the one chokepoint every AxonError passes
 * through on its way to disk/wire, means a bad context value degrades to a
 * string instead of crashing the writer.
 */
function toJsonSafe(value: Record<string, unknown>): Record<string, unknown> {
    try {
        return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    } catch {
        return { unserializable: String(value) }
    }
}

type CauseJSON = { message: string; stack?: string; frame?: AxonStackFrame | null } | string

/** cause is `unknown` by native Error.cause's own type — never assume it's JSON-safe (same reasoning as context). */
function causeToJSON(cause: unknown): CauseJSON {
    if (cause instanceof Error) {
        return {
            message: cause.message,
            ...(cause.stack !== undefined ? { stack: cause.stack } : {}),
            frame: firstRealFrame(cause.stack),
        }
    }
    try {
        JSON.stringify(cause)
        return String(cause)
    } catch {
        return "[unserializable cause]"
    }
}
