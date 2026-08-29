import type { BuildEventName } from "@arcforge/types"

/**
 * Boot progress — the build's own events, collapsed to what a human should
 * watch go by.
 *
 * A cold boot is seconds long and was reported as one word ("Booting…"), so a
 * `bun install` and an already-warm start looked identical. The build has been
 * fully traced for a while (see @arcforge/types' BuildEventMap); nothing here
 * measures anything new, it only decides which of those spans is worth a line
 * on a status bar.
 *
 * WHY NOT ALL OF THEM. The build has ten-odd spans and most complete in
 * milliseconds — framework reconcile, typegen, each scan domain. A stage that
 * flashes for 80ms is worse than no stage at all: the eye catches motion it
 * cannot read, and the bar looks like it is glitching rather than progressing.
 * So the fast units are grouped under the phase they belong to, and only the
 * spans that genuinely take time get their own name.
 *
 * `build:load` (the blueprint scan) is deliberately NOT a stage. It is fast,
 * and "Loading…" beside four concrete verbs reads as filler — the user cannot
 * act on it and it tells them nothing the next stage won't.
 */
export type BootStage =
    /** Framework reconcile, module resolution, typegen — the fast units, grouped. */
    | "preparing"
    /** `bun install`. Reliably the slowest thing in a cold boot. */
    | "dependencies"
    /** Compiling the cognet. Seconds when cold, absent when cached. */
    | "compiling"
    /** The runtime coming up — what "booting" now means, and only that. */
    | "booting"

/**
 * Display order, and the reason this list exists separately from the union:
 * the build does NOT emit stages in it.
 *
 * `build:typegen` is part of prepare but runs AFTER the cognet compiles, so a
 * bar that simply followed the events would read
 * "preparing → compiling → preparing" and appear to go backwards. Progress
 * that regresses is worse than coarse progress: it tells the user the thing
 * they are waiting on has restarted.
 *
 * So a stage only ever advances — see `advances()`. The rank is the contract;
 * the event order is not.
 */
const ORDER: readonly BootStage[] = ["preparing", "dependencies", "compiling", "booting"]

/**
 * May the bar move from `from` to `to`?
 *
 * Monotonic: forward moves only, and never a repeat of the stage already
 * showing. Callers use this to filter, so a late `build:typegen` inside prepare
 * does not drag the label back from "Compiling…".
 */
export function advances(from: BootStage | null, to: BootStage): boolean {
    if (from === null) return true
    return ORDER.indexOf(to) > ORDER.indexOf(from)
}

/**
 * One progress report — the stage, plus a count when the stage has an honest
 * one to give.
 *
 * `total` is only ever a number the build actually knows. The modules stage
 * knows how many the agent declares, so it can count them; `bun install` does
 * not know its package total until it has resolved the tree, so dependencies
 * reports no count rather than a fabricated one. A progress number that is
 * guessed is worse than none — it moves at the wrong rate and the user learns
 * to distrust the bar.
 */
export type BootProgress = {
    stage: BootStage
    /** 1-based position within the stage, when it counts. */
    index?: number
    /** How many in total, when the stage knows. */
    total?: number
    /** What is being worked on right now — a module specifier, say. */
    detail?: string
}

/**
 * A timed unit of the build — what it cost, reported when its span closes.
 *
 * Keyed by the UNIT, not by BootStage: the stages are a coarse projection for
 * a status bar ("preparing" covers three units), while a timing has to name
 * exactly what was measured. The header's modules row wants module install
 * specifically, not the whole prepare phase it sits inside.
 *
 * Answers a different question at a different time from BootProgress: progress
 * says "this is happening now", a timing says "that took N ms", and the latter
 * is only knowable once the unit is over.
 */
export type BuildUnit = "modules" | "dependencies" | "cognet"

export type UnitTiming = {
    unit: BuildUnit
    durationMs: number
}

/** The unit a `:complete` event closes, or null if it isn't one we time. */
export function unitFor(type: BuildEventName | string): BuildUnit | null {
    switch (type) {
        case "build:modules:complete": return "modules"
        case "build:tree:complete": return "dependencies"
        case "build:cognet:complete": return "cognet"
        default: return null
    }
}

/**
 * Which stage an event puts us in, or null for events that don't move the bar.
 *
 * Only `:start` events advance it: a stage ends because the next one begins,
 * never because its own span closed. Otherwise the bar would blank between
 * spans and flicker through every gap in the build.
 */
export function stageFor(type: BuildEventName | string): BootStage | null {
    switch (type) {
        // The interior units that are too fast to name individually. They all
        // report the phase they belong to, so the bar holds "Preparing…"
        // across the run of them instead of strobing.
        //
        // `build:typegen` is here despite running AFTER the cognet compiles —
        // it genuinely belongs to prepare. `advances()` is what stops it
        // dragging the label back; the mapping stays honest about the phase.
        case "build:prepare:start":
        case "build:framework:start":
        case "build:modules:start":
        case "build:typegen:start":
            return "preparing"
        case "build:tree:start": return "dependencies"
        case "build:cognet:start": return "compiling"
        // Scan is fast and unactionable — it holds whatever came before rather
        // than earning a name (see the note above).
        //
        // No case for `axon:boot:start`: it is committed by Axon()'s own
        // session, not this recorder, so it never reaches here. Agent() raises
        // "booting" directly at the point the build ends and the runtime
        // starts — the same moment, from the side that can observe it.
        default: return null
    }
}
