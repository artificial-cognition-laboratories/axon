/**
 * row — the labelled line. The most-used component in the package.
 *
 *   ➜  Local:    http://localhost:3141
 *   ➜  Agent:    @cody/dave
 *
 * ── Why `rows()` and not just `row()` ──────────────────────────────────────
 *
 * Label alignment is a property of a GROUP, not of a line: a row cannot know
 * how wide to pad without seeing its siblings. Exposing only the singular
 * would push that arithmetic into every caller, and they would each get it
 * slightly differently. So the plural is the real component and the singular
 * is the one-element case.
 */

import { icons, padEnd, hyperlink, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type Row = {
    label: string
    value: string
    /** Render the value as a clickable link to this URL. */
    href?: string
    /**
     * Lead with an arrow. Default true — an arrow means "somewhere you can go
     * or something you can act on". Set false for a plain attribute row.
     */
    arrow?: boolean
}

export type RowsOpts = {
    /**
     * Force the label column width instead of deriving it from these items.
     *
     * This is how two groups separated by a blank line keep ONE straight value
     * edge: the caller measures across both, then renders them apart. Without
     * it each call would align to itself and the column would step at the gap.
     */
    labelWidth?: number
}

/**
 * Render a group of rows with labels aligned to a common width.
 *
 * Returns one string per row so callers can interleave blank lines between
 * sub-groups without the alignment breaking.
 */
export function rows(r: RendererHandle, items: Row[], opts: RowsOpts = {}): string[] {
    if (items.length === 0) return []
    const labelWidth = opts.labelWidth ?? Math.max(...items.map(i => width(i.label)))

    // A group where nothing is arrowed sits flush left. The blank lead exists
    // only to hold the arrow column open when a group MIXES the two — paying
    // for it in a group that has no arrows at all is an indent nobody asked
    // for, and it makes an otherwise-flush view look accidentally nested.
    const anyArrowed = items.some(item => item.arrow !== false)

    return items.map(item => {
        const lead = item.arrow === false ? (anyArrowed ? " " : "") : r.c.primary(icons.arrow)
        const label = r.c.dim(padEnd(item.label + ":", labelWidth + 1))
        // A link keeps its primary colour whether or not it is clickable —
        // the colour is what marks it as a destination; the OSC 8 wrapper is
        // an enhancement the terminal may or may not honour.
        const painted = item.href ? r.c.primary(item.value) : r.c.text(item.value)
        const value = item.href && r.links ? hyperlink(item.href, painted) : painted
        return `${lead}${lead ? "  " : ""}${label}  ${value}`
    })
}

/** A single labelled line. See `rows()` — alignment only means something in a group. */
export function row(r: RendererHandle, item: Row): string {
    return rows(r, [item])[0]!
}
