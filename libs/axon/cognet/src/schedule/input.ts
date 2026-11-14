/**
 * Inputs — what enters the mind from outside, as something a system DECLARES.
 *
 * Not a component: stimuli are already in the session log, and writing a
 * frame's data URI into the world at 20Hz would log it twice. Not ambient
 * either: an undeclared input is invisible to the lineage and unenforced, and
 * the one edge a reader most needs — where the outside world gets in — would
 * be missing from the graph.
 *
 * So an input is a handle a system names in `reads`, like any component. The
 * lineage shows it as a source, only declaring systems receive it, and each
 * receives everything that arrived since IT last ran — a slow system misses
 * nothing, and a fast one sees each stimulus once.
 */
export type Input = {
    readonly kind: "input"
    readonly name: string
}

/** Stimuli committed since the reading system last ran, in seq order. */
export const stimuli: Input = Object.freeze({ kind: "input" as const, name: "stimuli" })

/**
 * The passing of time: changed on every tick. Not data — it carries
 * nothing, and is named only in `on` — but what runs a system that must
 * notice time pass when nothing it reads has changed. `run.now` is the
 * tick's time for any system; this is whether it WAKES for one.
 */
export const clock: Input = Object.freeze({ kind: "input" as const, name: "clock" })
