/**
 * The crash-report wire contract.
 *
 * One payload shape, posted by every side of the platform to
 * POST /api/reports. Lives here because three independent packages
 * construct it — @arcforge/cloud (HTTP failures), @axon/err (runtime
 * failures), and the backend's own 5xx handler — and a contract owned by
 * any one of them would make the other two depend on a transport.
 *
 * This is NOT a trace or a span. There is no parent, no tree, no duration.
 * A report says "this failed, here is enough to debug it" and nothing more —
 * the deliberate opposite of the event pipeline this replaced.
 */

/** Which side of the platform produced a report. */
export type ReportSource = "cloud" | "runtime" | "backend"

/**
 * One occurrence, as sent over the wire.
 *
 * The server derives the grouping fingerprint from this — clients never send
 * one. Fingerprinting is a server concern because it decides what counts as
 * "the same failure", and a client that computed its own could split a group
 * simply by shipping a different version of the hashing code.
 */
export type ErrorReport = {
    source: ReportSource

    /**
     * errorMap code (e.g. "AX-BOOT-001") when the failure went through err().
     * Absent for raw HTTP and network failures, which never had one — that
     * absence is meaningful and must not be filled with a placeholder.
     */
    code?: string

    /** Short headline. The map's title, or a summary of the HTTP failure. */
    message: string

    severity?: "error" | "fatal"

    /**
     * The release this occurred on. Without it a group cannot distinguish
     * "fixed two versions ago" from "still happening on HEAD", which is the
     * first question an operator asks.
     */
    release?: string

    /** Coarse runtime descriptor, e.g. "bun-1.1/linux". Never a hostname or a username. */
    platform?: string

    stack?: string

    /**
     * Structured frames when the source has them (err() captures these).
     * Preferred over `stack` for fingerprinting: a parsed frame survives
     * minification and path differences that break naive stack-string hashing.
     */
    frames?: ReportFrame[]

    /**
     * Caller-supplied detail. SCRUBBED BEFORE SENDING — see scrubContext()
     * in @arcforge/cloud. This is the one field that can carry user data
     * (paths, prompt text, agent names), so it is the one field that must
     * never be forwarded raw.
     */
    context?: Record<string, unknown>

    /** Flattened cause chain, outermost first. */
    cause?: string
}

/** A stack frame, reduced to what fingerprinting and display need. */
export type ReportFrame = {
    functionName: string | null
    fileName: string | null
    lineNumber: number | null
}

/** What POST /api/reports answers. */
export type ErrorReportAck = {
    /** The group this occurrence landed in. */
    fingerprint: string
    /** How many times this group has now been seen. */
    occurrences: number
}
