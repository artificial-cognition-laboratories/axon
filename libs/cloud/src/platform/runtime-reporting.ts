import { toReportFrames } from "./reporting"
import type { ReportingHandle } from "./reporting"

/**
 * The shape this bridge needs from an AxonError, without importing @axon/err.
 *
 * @arcforge/cloud must not depend on the runtime error package — the
 * dependency runs the other way (the runtime uses the cloud client), and
 * reversing it would make a browser bundle of this client pull in
 * node:async_hooks. Structural typing is enough: the host passes errors in,
 * this reads the fields it needs.
 */
export type ReportableError = {
    code: string
    title: string
    message: string
    severity: string
    source: string
    /** True when the user caused this and can fix it — see the filter below. */
    expected?: boolean
    context?: Record<string, unknown>
    frames?: Array<{ functionName: string | null; fileName: string | null; lineNumber: number | null }>
    stack?: string
    cause?: unknown
}

/**
 * Decide whether a runtime error is worth reporting.
 *
 * Two filters, and both matter more than they look:
 *
 * `expected` — the errorMap marks failures the USER caused and can fix:
 * running `axon publish` outside a project, naming a prompt that does not
 * exist. These are typos, not bugs. There are hundreds of them for every
 * real fault, and including them is exactly how a crash dashboard becomes
 * something nobody opens. The map already carries this flag, so the filter
 * is STRUCTURAL rather than a heuristic over messages.
 *
 * `severity` — only "fatal" means the operation did not complete.
 * "recovered" and "degraded" are the system working as designed: a fallback
 * fired, a cache missed and will retry. Reporting them would turn every
 * successful retry into an alert.
 *
 * The result: what arrives is "our code broke and the user's work stopped",
 * which is the only thing that should ever page an operator.
 */
export function isReportable(error: ReportableError): boolean {
    if (error.expected === true) return false
    return error.severity === "fatal"
}

/**
 * Bridge @axon/err's observer to the outbound crash channel.
 *
 * The host wires this ONCE at startup:
 *
 *     const cloud = AxonCloud({ ... })
 *     observeErrors(reportRuntimeErrors(cloud.reporting))
 *
 * Kept here rather than inside AxonCloud() because construction must stay
 * wiring-only: subscribing to a process-global observer is a side effect
 * with a lifetime, and it belongs to whoever owns the process, not to a
 * client handle that may be built more than once.
 */
export function reportRuntimeErrors(reporting: ReportingHandle): (error: ReportableError) => void {
    return error => {
        if (!isReportable(error)) return

        reporting.send({
            source: "runtime",
            code: error.code,
            // The map's title is the stable headline; message is the specific
            // instance. Title first means a group reads as the failure KIND,
            // with the instance detail available in the sample.
            message: error.title,
            severity: "fatal",
            ...(error.stack !== undefined ? { stack: error.stack } : {}),
            ...(error.frames !== undefined ? { frames: toReportFrames(error.frames) } : {}),
            ...(error.context !== undefined ? { context: error.context } : {}),
            ...(error.cause !== undefined ? { cause: describeCause(error.cause) } : {}),
        })
    }
}

/** Flatten a cause to one line — the reason, not the whole chain's objects. */
function describeCause(cause: unknown): string {
    if (cause instanceof Error) return `${cause.name}: ${cause.message}`
    if (typeof cause === "string") return cause
    try {
        return JSON.stringify(cause)?.slice(0, 500) ?? String(cause)
    } catch {
        return "[unserializable cause]"
    }
}
