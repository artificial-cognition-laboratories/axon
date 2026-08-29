/**
 * logs — a tail of container output.
 *
 *   │ INFO   starting axon runtime v2.0.158
 *   │ ERROR  Cannot find module 'node:sqlite'
 *
 * Exists because a failed deployment's most useful content is what the
 * container itself said. The control plane reports "RevisionFailed"; the log
 * tail reports "your module threw at import", which is the line the user
 * actually needs. Sending them to a separate `axon logs` for it costs a round
 * trip at the worst possible moment.
 *
 * Severity is colour, not prefix decoration: an error line is red so the eye
 * finds it in a wall of INFO, which is the entire job of this component.
 */

import { icons, padEnd, truncate, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type LogLine = {
    /** The provider's own level string — INFO, ERROR, WARNING, DEBUG, … */
    severity: string
    message: string
}

export type LogsOpts = {
    /**
     * Most recent lines to show. Default 10.
     *
     * Capped because this is embedded in an error report, not a log viewer: a
     * hundred lines buries the error block it is meant to explain, and the
     * full tail is one command away.
     */
    limit?: number
}

/** Severity strings that should read as failure, whatever the provider calls them. */
const ERROR_LEVELS = new Set(["ERROR", "CRITICAL", "ALERT", "EMERGENCY", "FATAL"])
const WARN_LEVELS = new Set(["WARNING", "WARN"])

export function logs(r: RendererHandle, lines: LogLine[], opts: LogsOpts = {}): string[] {
    if (lines.length === 0) return [r.c.dim("no output")]

    const limit = opts.limit ?? 10
    const shown = lines.slice(-limit)
    const hidden = lines.length - shown.length

    const levelWidth = Math.max(...shown.map(l => width(l.severity)))
    // The gutter, the level column and the two gaps around it. Anything past
    // this wraps in the terminal and destroys the column, so it is cut instead.
    const room = r.columns - (levelWidth + 4)

    const rendered = shown.map(line => {
        const level = padEnd(line.severity.toUpperCase(), levelWidth)
        const paint = ERROR_LEVELS.has(line.severity.toUpperCase())
            ? r.c.error
            : WARN_LEVELS.has(line.severity.toUpperCase())
                ? r.c.warn
                : r.c.dim

        return `${r.c.dim(icons.pipe)} ${paint(level)}  ${r.c.dim(truncate(line.message, room))}`
    })

    // Said explicitly rather than silently dropped: a user reading a tail needs
    // to know it IS a tail, or they will conclude the run started here.
    return hidden > 0
        ? [r.c.dim(`${icons.pipe} … ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`), ...rendered]
        : rendered
}
