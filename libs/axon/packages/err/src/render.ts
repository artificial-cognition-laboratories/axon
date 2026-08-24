import type { AxonErrorSeverity, AxonErrorSource } from "./map"
import type { AxonStackFrame } from "./stack"

/**
 * Rust-style call-site rendering — pure formatting over plain data. Every
 * field here already lives on AxonError (map.ts's identity fields + the
 * frames/snippets stack.ts captured at construction time) — nothing is
 * parsed back out of a string, no disk access happens here. A future TUI
 * component renders the exact same AxonErrorLike shape with its own layout;
 * this module is one legitimate renderer of it, not the source of truth.
 */

export type AxonErrorLike = {
    code: string
    title: string
    description: string
    message: string
    severity: AxonErrorSeverity
    source: AxonErrorSource
    context: Record<string, unknown> | undefined
    frames: AxonStackFrame[]
    cause?: unknown
    /** The user caused this and can fix it — renders without our internals. See map.ts. */
    expected?: boolean
}

/** One frame, Rust-style: file:line:col, then its captured source context with a caret. */
export function renderFrame(frame: AxonStackFrame): string {
    if (!frame.fileName || frame.lineNumber === null) {
        return frame.functionName ? `at ${frame.functionName}` : "at <unknown>"
    }

    const location = `${frame.fileName}:${frame.lineNumber}:${frame.columnNumber ?? 0}`
    const header = frame.functionName ? `at ${frame.functionName} (${location})` : `at ${location}`

    const snippet = frame.source ? renderSnippet(frame.source, frame.lineNumber, frame.columnNumber) : null
    return snippet ? `${header}\n${snippet}` : header
}

const RULE_WIDTH = 80

/**
 * The renderable report.
 *
 * Two shapes, chosen by whose fault the failure is:
 *
 *   EXPECTED   headline + description + context. `axon publish` outside a
 *              project is a typo; the description already says exactly what
 *              to do, and eighty lines of our call stack underneath tells the
 *              user to debug software they did not write.
 *
 *   otherwise  the full report — frames, source snippets, cause chain. An
 *              unclassified failure IS ours, and this is what makes it
 *              debuggable from a pasted terminal log.
 *
 * The default is the full report (see map.ts's `expected`), so forgetting to
 * classify a code costs a noisy message and never a hidden bug.
 */
export function renderError(error: AxonErrorLike): string {
    const lines = [`Axon Error: ${error.title}`, error.description]

    if (error.message && error.message !== error.title) {
        lines.push("", error.message)
    }

    if (error.context && Object.keys(error.context).length > 0) {
        lines.push("", "Context:", indent(renderContext(error.context)))
    }

    // OUR frames are what an expected failure omits — they describe code the
    // user did not write and cannot act on.
    if (!error.expected) {
        lines.push("─".repeat(RULE_WIDTH), ...error.frames.map(renderFrame))
    }

    // A cause survives either way: something deliberately attached it, and it
    // names the underlying fault ("ECONNREFUSED" under a missing file), which
    // is the most actionable line in the whole report. Suppressing it would
    // leave the user reading "the file is missing" with no hint that the real
    // problem was the network.
    if (error.cause !== undefined) {
        lines.push("", "Caused by:", indent(causeMessage(error.cause)))
    }

    return ["", lines.join("\n"), ""].join("\n")
}

function renderContext(context: Record<string, unknown>): string {
    return Object.entries(context)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : safeStringify(value)}`)
        .join("\n")
}

/** JSON.stringify throws on circular structures — context is caller-supplied and not guaranteed serializable, so rendering it must never itself throw. */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function causeMessage(cause: unknown): string {
    return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
}

function indent(text: string): string {
    return text.split("\n").map(line => `  ${line}`).join("\n")
}

/** Gutter-numbered source lines with a caret under the reported column — all from already-captured data, no disk read. */
function renderSnippet(source: AxonStackFrame["source"], lineNumber: number, columnNumber: number | null): string | null {
    if (!source || source.length === 0) return null

    const gutterWidth = String(source[source.length - 1]!.lineNumber).length

    const rendered: string[] = []
    for (const line of source) {
        const num = String(line.lineNumber).padStart(gutterWidth, " ")
        const marker = line.lineNumber === lineNumber ? ">" : " "
        rendered.push(`  ${marker} ${num} | ${line.text}`)
        if (line.lineNumber === lineNumber && columnNumber !== null) {
            const caretPad = " ".repeat(gutterWidth + 6 + Math.max(0, columnNumber - 1))
            rendered.push(`${caretPad}^`)
        }
    }

    return rendered.join("\n")
}
