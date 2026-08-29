/**
 * entries — a list of things you might pick one of.
 *
 *   @axon/obsidian        module  1.4.0  installed      ★ 42  ↓ 1.2k
 *     Read and write an Obsidian vault from your agent.
 *
 *   @cody/notion          module  0.2.0                    ★ 8  ↓ 140
 *     Notion pages and databases as agent memory.
 *
 * ── Why not a table ────────────────────────────────────────────────────────
 *
 * A table gives every field the same weight and a fixed column, which is
 * exactly wrong here: the name and the description are the CONTENT, and the
 * kind, version and counts are metadata you glance at only after one entry has
 * caught your eye. Columns force them to compete.
 *
 * It is also what makes a table unreadable at 80 columns. Six columns of
 * registry data do not fit, so the description — the only field that answers
 * "is this the thing I want?" — gets truncated to whatever is left, usually
 * around 40 characters. Given its own line it truncates at the terminal
 * instead, which is three times the room on the same screen.
 *
 * Two lines per entry rather than one, for the same reason cargo, npm and brew
 * all do it: the left edge stays a clean column of names to scan, and nothing
 * the eye is scanning past shifts position because a sibling had a long
 * version string.
 */

import { icons, padEnd, truncate, width, wrap } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type Entry = {
    /** The name. The thing being scanned for. */
    name: string
    /** One-line summary. Wrapped, not truncated, when it has the room. */
    description?: string
    /** Dim label after the name — a kind, a status. */
    label?: string
    /** Dim value after the label — a version. */
    version?: string
    /** Right-aligned counts, rendered with their glyph. */
    stats?: { stars?: number; installs?: number }
    /** Makes the name clickable. */
    href?: string
    /** Marks this entry as already present locally. */
    installed?: boolean
}

export type EntriesOpts = {
    /**
     * Wrap descriptions onto further lines rather than truncating at one.
     *
     * Off by default: in a list of twenty, a wrapped paragraph breaks the
     * one-entry-one-block rhythm that makes the list scannable. Worth turning
     * on for a short result set where reading beats skimming.
     */
    wrapDescriptions?: boolean
}

export function entries(r: RendererHandle, items: Entry[], opts: EntriesOpts = {}): string[] {
    if (items.length === 0) return []

    const lines: string[] = []
    const indent = "  "

    // The metadata column is placed against the widest NAME, so kind and
    // version line up down the list instead of trailing each name raggedly.
    // Capped so one very long name cannot push the whole column off-screen.
    const nameWidth = Math.min(
        Math.max(...items.map(i => width(i.name))),
        Math.max(20, Math.floor(r.columns * 0.4)),
    )

    // Labels share a column too, so `agent` and `module` start at the same
    // place and the version after them does as well. Without this the shorter
    // label pulls its version left and the metadata reads as ragged.
    const labelWidth = Math.max(0, ...items.map(i => width(i.label ?? "")))
    const versionWidth = Math.max(0, ...items.map(i => width(i.version ?? "")))
    // Measured on the FORMATTED counts — "1.2k" is four characters whatever
    // 1247 suggests.
    const statWidths = {
        stars: Math.max(0, ...items.map(i => (i.stats?.stars !== undefined ? compact(i.stats.stars).length : 0))),
        installs: Math.max(0, ...items.map(i => (i.stats?.installs !== undefined ? compact(i.stats.installs).length : 0))),
    }

    items.forEach((item, index) => {
        if (index > 0) lines.push("")

        const name = r.c.primary(padEnd(truncate(item.name, nameWidth), nameWidth))
        const label = item.label ? r.c.dim(padEnd(item.label, labelWidth)) : " ".repeat(labelWidth)
        const version = item.version ? r.c.dim(item.version) : ""

        // Stats sit INLINE with the other metadata, not against the right
        // margin.
        //
        // Right-aligning them looked orderly at 80 columns and fell apart at
        // 120: the numbers drifted half a screen from the entry they described
        // and read as belonging to nothing. Metadata belongs beside the thing
        // it is about, and every other field on this line already is.
        const stats = renderStats(r, item.stats, statWidths)
        const parts = [
            name,
            label,
            padEnd(version, versionWidth),
            stats ?? "",
            item.installed ? r.c.dim("installed") : "",
        ]

        lines.push(parts.join("  ").trimEnd())

        if (item.description) {
            const room = r.columns - indent.length
            const body = opts.wrapDescriptions
                ? wrap(item.description, room)
                : [truncate(item.description, room)]
            for (const line of body) lines.push(indent + r.c.dim(line))
        }
    })

    return lines
}

/**
 * `★ 42  ↓ 1.2k`, with each number padded to the widest in the list.
 *
 * The two counts are measured SEPARATELY rather than the composed string being
 * padded as a whole: padding the whole only aligns its right edge, which lets
 * the download arrow wander left and right down the list while the stars stay
 * put. Each glyph gets its own column instead.
 */
function renderStats(
    r: RendererHandle,
    stats: Entry["stats"],
    widths: { stars: number; installs: number } = { stars: 0, installs: 0 },
): string | undefined {
    if (!stats) return undefined

    const parts: string[] = []
    if (widths.stars > 0) {
        const value = stats.stars !== undefined ? compact(stats.stars) : ""
        parts.push(value ? `${icons.star} ${value.padStart(widths.stars)}` : " ".repeat(widths.stars + 2))
    }
    if (widths.installs > 0) {
        const value = stats.installs !== undefined ? compact(stats.installs) : ""
        parts.push(value ? `${icons.installs} ${value.padStart(widths.installs)}` : " ".repeat(widths.installs + 2))
    }
    if (parts.length === 0) return undefined

    return r.c.dim(parts.join("  "))
}

/**
 * 1200 → "1.2k".
 *
 * Exact counts past a thousand are noise in a list: nobody chooses between two
 * packages on the difference between 1,203 and 1,240 installs, and the extra
 * digits cost alignment on every row.
 */
export function compact(n: number): string {
    if (n < 1000) return String(n)
    if (n < 1_000_000) {
        const k = n / 1000
        return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`
    }
    const m = n / 1_000_000
    return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`
}
