/**
 * errorReport — an `err()` failure, rendered for a terminal.
 *
 * ── Relationship to @arcforge/err's renderError ────────────────────────────
 *
 * `err`'s own `render.ts` says it plainly: it is ONE renderer of the
 * `AxonErrorLike` shape, not the source of truth, and a component with its own
 * layout is expected to render the same data. This is that component. It takes
 * the same structured input and adds colour, icons and the package's spacing
 * conventions; it parses nothing back out of a string and reads nothing from
 * disk, because every field it needs was captured at construction time.
 *
 * The `expected` split is err's decision, not ours, and is reproduced exactly:
 * a failure the USER caused renders headline + description + context, with no
 * stack, because our frames describe code they did not write. Anything
 * unclassified gets the full report — that default is what keeps a forgotten
 * classification a noisy message rather than a hidden bug.
 */

import { icons, width, wrap } from "../core/index.ts"
import { logs, type LogLine } from "./logs.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"
import type { AxonStackFrame } from "@arcforge/types"

export type ErrorReportOpts = {
    /**
     * Show stack frames for an unexpected failure. Default true.
     *
     * Set false only where the caller has somewhere better to send them — a
     * log file, a session event. Never to make an error look tidier.
     */
    frames?: boolean
    /**
     * The command that resolves this, e.g. "axon login".
     *
     * Rendered last, where the eye lands after reading the failure. An error a
     * developer can act on without leaving the terminal is the difference
     * between a good dev surface and a bad one — but only the CALLER knows
     * what to suggest, since the same code means different next steps in
     * different commands. Never invented from the error itself.
     */
    hint?: string
    /**
     * Output from the thing that failed — a container's own log tail.
     *
     * Not part of AxonErrorLike because it is not a property of the error, it
     * is evidence gathered ABOUT it: `DeploymentFailedError` fetches a tail
     * best-effort when a deployment enters `error`. Rendered last before the
     * hint, where it reads as the explanation for everything above it.
     */
    output?: LogLine[]
}

export function errorReport(r: RendererHandle, error: AxonErrorLike, opts: ErrorReportOpts = {}): string[] {
    const lines: string[] = []
    const { c } = r

    // Headline: the code is the stable identity a support thread references,
    // so it is always present and always adjacent to the title.
    lines.push(`${c.error(icons.fail)} ${c.bold(c.error(error.title))} ${c.dim(error.code)}`)
    lines.push("")

    for (const line of wrap(error.description, prose(r))) {
        lines.push(c.text(line))
    }

    // The message is the specific detail behind the generic title. When err()
    // was given no detail the two are identical and repeating it is noise.
    if (error.message && error.message !== error.title) {
        lines.push("")
        for (const line of wrap(error.message, prose(r))) {
            lines.push(c.dim(line))
        }
    }

    if (error.context && Object.keys(error.context).length > 0) {
        lines.push("")
        lines.push(c.bold("Context"))
        lines.push(...contextLines(r, error.context))
    }

    if (!error.expected && (opts.frames ?? true) && error.frames.length > 0) {
        lines.push("")
        lines.push(c.bold("Trace"))
        lines.push(...framesLines(r, error.frames))
    }

    // A cause survives the `expected` split: something deliberately attached
    // it, and it names the underlying fault — often the most actionable line
    // in the report.
    if (error.cause !== undefined) {
        lines.push("")
        lines.push(c.bold("Caused by"))
        lines.push(`${c.dim(icons.elbow)} ${c.error(causeMessage(error.cause))}`)
    }

    if (opts.output?.length) {
        lines.push("")
        lines.push(c.bold("Container output"))
        lines.push(...logs(r, opts.output))
    }

    if (opts.hint) {
        lines.push("")
        lines.push(`${c.primary(icons.arrow)}  ${c.text(opts.hint)}`)
    }

    return lines
}

/**
 * The width prose is wrapped to.
 *
 * Capped well below the terminal on a wide window: a 200-column paragraph is
 * physically hard to read back to the next line, and every typographic
 * convention puts the comfortable measure far below that.
 */
function prose(r: RendererHandle): number {
    return Math.min(r.columns, 84)
}

function contextLines(r: RendererHandle, context: Record<string, unknown>): string[] {
    const entries = Object.entries(context)
    const keyWidth = Math.max(...entries.map(([k]) => k.length))

    return entries.map(([key, value], i) => {
        const last = i === entries.length - 1
        const connector = r.c.dim(last ? icons.elbow : icons.tee)
        return `${connector} ${r.c.dim(key.padEnd(keyWidth))}  ${r.c.text(stringify(value))}`
    })
}

/**
 * Frames, each optionally followed by the source context captured with it.
 *
 * The frame nearest the throw is the one that matters, so frames render in
 * capture order and the first is the only one shown with weight.
 */
function framesLines(r: RendererHandle, frames: AxonStackFrame[]): string[] {
    const lines: string[] = []

    frames.forEach((frame, i) => {
        const location = frame.fileName !== null && frame.lineNumber !== null
            ? `${frame.fileName}:${frame.lineNumber}:${frame.columnNumber ?? 0}`
            : null

        const name = frame.functionName ?? "<anonymous>"
        const text = location ? `${name} ${r.c.dim(location)}` : name
        lines.push(`${r.c.dim(icons.pipe)} ${i === 0 ? r.c.text(text) : r.c.dim(text)}`)

        if (i === 0 && frame.source?.length) {
            lines.push(...snippetLines(r, frame))
        }
    })

    return lines
}

/** Gutter-numbered source with a caret under the reported column. */
function snippetLines(r: RendererHandle, frame: AxonStackFrame): string[] {
    const source = frame.source
    if (!source?.length) return []

    const gutter = String(source[source.length - 1]!.lineNumber).length
    const lines: string[] = []

    for (const line of source) {
        const num = String(line.lineNumber).padStart(gutter)
        const hit = line.lineNumber === frame.lineNumber
        const marker = hit ? r.c.error(">") : " "
        const body = hit ? r.c.text(line.text) : r.c.dim(line.text)
        lines.push(`${r.c.dim(icons.pipe)}  ${marker} ${r.c.dim(num)} ${r.c.dim(icons.pipe)} ${body}`)

        if (hit && frame.columnNumber !== null) {
            // The caret must land under the reported column, so its indent is
            // measured from the SAME prefix the code line above was built from
            // rather than recomputed — the two drifting apart is what makes a
            // caret point at the wrong token, which is worse than no caret.
            const prefix = `  ${marker} ${num} ${icons.pipe} `
            const pad = " ".repeat(width(prefix) + Math.max(0, frame.columnNumber - 1))
            lines.push(`${r.c.dim(icons.pipe)}${pad}${r.c.error("^")}`)
        }
    }

    return lines
}

function causeMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message
    return String(cause)
}

function stringify(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}
