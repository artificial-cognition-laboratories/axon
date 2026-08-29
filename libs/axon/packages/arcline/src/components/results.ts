/**
 * results — a batch of items, each with its own outcome.
 *
 *   ✓ @cody/obsidian   0.4.2   installed
 *   ✓ @axon/github     1.1.0   installed
 *   · @cody/notion     0.2.0   already installed
 *   ✗ @cody/typoo              not found in the registry
 *
 * ── Why this is not `steps` ────────────────────────────────────────────────
 *
 * A step list is a fixed SEQUENCE: known in advance, run in order, one active
 * at a time. A batch is a SET: the items are supplied by the user, they may
 * complete in any order, and — the part that matters — each carries its own
 * verdict rather than sharing the run's.
 *
 * The distinction earns a component because of one case. "Already installed"
 * is neither success nor failure: nothing was wrong and nothing was done. A
 * step list has no way to say that, so the old output rendered it with a green
 * ✓ identical to a real install, and a batch of five where one was new looked
 * exactly like a batch where all five were. Making "nothing happened" visually
 * distinct from "something happened" is the whole job here.
 */

import { icons, padEnd, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type ResultOutcome =
    /** Work was done. */
    | "ok"
    /** Already in the desired state — nothing to do, and nothing wrong. */
    | "noop"
    /** Did not succeed. */
    | "fail"
    /** Still running. */
    | "active"
    /** Not started. */
    | "waiting"

export type Result = {
    /** What the item is — a module name, a file, an agent. */
    name: string
    outcome: ResultOutcome
    /** Middle column — a version, a size. Aligned across the batch. */
    detail?: string
    /** Trailing plain-language verdict: "installed", "not found in the registry". */
    note?: string
}

export type ResultsOpts = {
    /** Spinner glyph for any active row, supplied by the live surface. */
    frame?: string
}

export function results(r: RendererHandle, items: Result[], opts: ResultsOpts = {}): string[] {
    if (items.length === 0) return []

    const nameWidth = Math.max(...items.map(i => width(i.name)))
    const detailWidth = Math.max(0, ...items.map(i => width(i.detail ?? "")))

    return items.map(item => {
        const glyph = glyphFor(r, item.outcome, opts.frame)

        // A no-op is dimmed WHOLE — name included. The eye should skip it and
        // land on the rows that represent actual change, which is the question
        // anyone re-running an install is asking.
        const paint = item.outcome === "noop" || item.outcome === "waiting"
            ? r.c.dim
            : item.outcome === "fail"
                ? r.c.error
                : r.c.text

        const name = paint(padEnd(item.name, nameWidth))
        const detail = detailWidth > 0 ? "  " + r.c.dim(padEnd(item.detail ?? "", detailWidth)) : ""
        const note = item.note ? "  " + r.c.dim(item.note) : ""

        return `${glyph} ${name}${detail}${note}`.trimEnd()
    })
}

function glyphFor(r: RendererHandle, outcome: ResultOutcome, frame: string | undefined): string {
    switch (outcome) {
        case "ok":      return r.c.primary(icons.ok)
        case "fail":    return r.c.error(icons.fail)
        case "active":  return r.c.primary(frame ?? icons.pending)
        // Deliberately NOT a ✓. A tick claims work was done; this row exists to
        // say the opposite, and a dimmed bullet reads as "present, untouched".
        case "noop":    return r.c.dim(icons.pending)
        case "waiting": return " "
    }
}

/**
 * "installed 2 modules", "1 of 3 failed" — the one line that says how a batch
 * went, given the batch.
 *
 * The noun is the caller's because this component knows nothing about what it
 * is listing; only the shape of the outcome.
 *
 * Derived rather than passed in, so the summary can never disagree with the
 * rows above it.
 */
export function summarize(
    items: Result[],
    opts: { verb: string; noun: string; plural?: string },
): { ok: boolean; text: string } {
    const done = items.filter(i => i.outcome === "ok").length
    const failed = items.filter(i => i.outcome === "fail").length
    const noop = items.filter(i => i.outcome === "noop").length

    if (failed > 0) {
        return { ok: false, text: `${failed} of ${items.length} failed` }
    }
    if (done === 0 && noop > 0) {
        return { ok: true, text: "nothing to do" }
    }
    const noun = done === 1 ? opts.noun : opts.plural ?? `${opts.noun}s`
    return { ok: true, text: `${opts.verb} ${done} ${noun}` }
}
