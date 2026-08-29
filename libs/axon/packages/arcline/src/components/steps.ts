/**
 * steps — a checklist of work, one line per step.
 *
 *   ✓ Bundling    412ms
 *   ⠹ Uploading   2.1s
 *     Verifying
 *
 * Pure, like every component: it renders a step LIST, and knows nothing about
 * time passing. What makes it animate is that a live surface calls it again
 * with a new `frame` and a new elapsed value — the spinner glyph is an input,
 * not something this file owns.
 *
 * That split is the whole design. A step list is the thing every long Axon
 * operation is (publish, deploy, install), and keeping it a pure function of
 * its state means it can be snapshot-tested, rendered once into a CI log, or
 * repainted sixty times in a terminal, from one implementation.
 */

import { icons, padEnd, width } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

export type StepState = "waiting" | "active" | "done" | "failed"

export type Step = {
    label: string
    state: StepState
    /**
     * Elapsed milliseconds. Rendered for anything that has started — a running
     * step shows time accruing, which is what distinguishes "slow" from "hung".
     *
     * For a FINISHED step this is the final duration. For a running one, set
     * `since` instead: a stored elapsed is a snapshot of the moment it was
     * written, so a live surface repainting sixty times a second would show
     * the same frozen number on every frame.
     */
    ms?: number
    /**
     * When an active step began, as `performance.now()`.
     *
     * The clock is read AT RENDER TIME rather than pushed in, which is what
     * makes the counter actually count: the view is already called on every
     * tick to advance the spinner, so it has a free opportunity to recompute
     * elapsed — and a caller that reports one step transition per phase does
     * not have to tick a timer by hand to get a live number.
     */
    since?: number
    /** Trailing context — a version, a size, a reason for failure. */
    detail?: string
    /**
     * Completion 0–1, when the step genuinely knows it.
     *
     * Rare, and deliberately so: a bar that advances on guesswork is worse
     * than a spinner, because it makes a promise about remaining time that
     * nothing is keeping. Only work with a real denominator — a download
     * against content-length — should set this.
     */
    progress?: number
}

export type StepsOpts = {
    /**
     * The spinner glyph for the active step, supplied by the caller because it
     * changes with time and this component does not own a clock.
     *
     * Absent means no animation: the active step falls back to a static glyph,
     * which is the correct rendering for a non-interactive log.
     */
    frame?: string
}

/** Braille dot cycle — the frames a live surface advances through. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export function steps(r: RendererHandle, items: Step[], opts: StepsOpts = {}): string[] {
    if (items.length === 0) return []
    const labelWidth = Math.max(...items.map(i => width(i.label)))

    return items.map(item => {
        const glyph = glyphFor(r, item, opts.frame)

        // A waiting step is dimmed to the point of being scenery: it says what
        // is coming without competing with the step actually running.
        const label = item.state === "waiting"
            ? r.c.dim(padEnd(item.label, labelWidth))
            : item.state === "failed"
                ? r.c.error(padEnd(item.label, labelWidth))
                : r.c.text(padEnd(item.label, labelWidth))

        // `since` wins while running; `ms` is the settled figure once done.
        const elapsed = item.state === "active" && item.since !== undefined
            ? performance.now() - item.since
            : item.ms

        const trail = [
            elapsed !== undefined ? duration(elapsed) : "",
            item.detail ?? "",
        ].filter(Boolean).join("  ")

        // The bar sits after the detail, and only while the step is running —
        // a finished step's bar is a full bar, which says nothing the ✓ has
        // not already said.
        const bar = item.state === "active" && item.progress !== undefined
            ? "  " + renderBar(r, item.progress)
            : ""

        return `${glyph} ${label}${trail ? "  " + r.c.dim(trail) : ""}${bar}`.trimEnd()
    })
}

/** A fixed-width bar. Narrow by design — it is an annotation, not the subject. */
function renderBar(r: RendererHandle, progress: number, width = 16): string {
    const filled = Math.round(Math.max(0, Math.min(1, progress)) * width)
    return r.c.primary("━".repeat(filled)) + r.c.faint("━".repeat(width - filled))
}

function glyphFor(r: RendererHandle, item: Step, frame: string | undefined): string {
    switch (item.state) {
        case "done":    return r.c.primary(icons.ok)
        case "failed":  return r.c.error(icons.fail)
        case "active":  return r.c.primary(frame ?? icons.pending)
        // A blank keeps the label column aligned without drawing a glyph for
        // work that has not begun — a bullet there reads as a completed item.
        case "waiting": return " "
    }
}

/**
 * Milliseconds as something a person reads at a glance.
 *
 * Sub-second work is reported in ms because that is the unit its differences
 * live in; past a second, tenths are all anyone acts on.
 */
export function duration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
}
