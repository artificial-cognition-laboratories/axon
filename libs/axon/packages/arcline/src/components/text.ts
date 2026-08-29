/**
 * text — the one-line primitives. A status line, a rule, a bullet list.
 *
 * These are the components with no internal structure worth a file of their
 * own; they exist so that a "✓ something" line is spelled the same way in
 * every Axon surface.
 */

import { icons, padEnd, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type Status = "ok" | "fail" | "pending" | "info" | "warn"

const PAINT: Record<Status, (r: RendererHandle) => (t: string) => string> = {
    ok:      r => r.c.primary,
    fail:    r => r.c.error,
    pending: r => r.c.dim,
    info:    r => r.c.primary,
    warn:    r => r.c.warn,
}

const GLYPH: Record<Status, string> = {
    ok: icons.ok,
    fail: icons.fail,
    pending: icons.pending,
    info: icons.info,
    warn: icons.warn,
}

/**
 * A status line: glyph, message, optional trailing detail.
 *
 *   ✓ Built  1.2s
 *   ✗ Upload failed  connection reset
 */
export function status(
    r: RendererHandle,
    kind: Status,
    message: string,
    detail?: string,
    /**
     * Spinner glyph, replacing the `pending` bullet.
     *
     * Only `pending` accepts one: the other kinds are settled verdicts and
     * nothing about them is still moving. Supplied by the live surface, same
     * as `steps` — this component still owns no clock.
     */
    frame?: string,
): string {
    const glyph = kind === "pending" && frame
        ? r.c.primary(frame)
        : PAINT[kind](r)(GLYPH[kind])
    const body = kind === "fail" ? r.c.error(message) : r.c.text(message)
    return `${glyph} ${body}${detail ? " " + r.c.dim(detail) : ""}`
}

/**
 * The command to run next.
 *
 *   ➜  cd zeno && axon dev
 *
 * Its own component rather than a `status` variant because it is not a report
 * of what happened — it is an instruction, and it is usually the line the
 * whole view exists to deliver. Rendered in primary so the eye lands on it
 * after reading past everything else.
 */
export function next(r: RendererHandle, command: string): string {
    return `${r.c.primary(icons.arrow)}  ${r.c.text(command)}`
}

/** A horizontal rule spanning the full available width. */
export function rule(r: RendererHandle): string {
    return r.c.dim("─".repeat(Math.max(0, r.columns)))
}

/** A dimmed bullet list. */
export function list(r: RendererHandle, items: string[]): string[] {
    return items.map(item => `${r.c.dim(icons.pending)} ${r.c.text(item)}`)
}

/**
 * A table with auto-sized columns.
 *
 * Columns are sized to their widest cell, then the whole table is left as-is:
 * truncation is the caller's decision, because only it knows which column is
 * expendable.
 */
export function table(r: RendererHandle, headers: string[], data: string[][]): string[] {
    if (data.length === 0) return [r.c.dim("no results")]

    const widths = headers.map((h, i) =>
        Math.max(width(h), ...data.map(row => width(row[i] ?? ""))),
    )

    const lines: string[] = []
    lines.push(headers.map((h, i) => r.c.bold(padEnd(h, widths[i]!))).join("  "))
    lines.push(r.c.dim("─".repeat(widths.reduce((a, b) => a + b, 0) + (headers.length - 1) * 2)))
    for (const row of data) {
        lines.push(row.map((cell, i) => r.c.text(padEnd(cell ?? "", widths[i]!))).join("  "))
    }
    return lines
}
