import type { ComponentType } from "../ecs"

/**
 * One system: a private rate, a place in the pipeline, and the beliefs it
 * touches.
 *
 * `Ctx` is whatever the cognet hands every system on a tick — its world, the
 * tick's stimuli, "now". The schedule never looks inside it beyond `now`, so a
 * mind decides its own context without the runtime knowing its shape.
 */
export type SystemSpec<Ctx extends SystemContext = SystemContext, Phase extends string = string> = {
    name: string
    /** The tick stage this belongs to. Data, not folders — moving a system is a one-line edit. */
    phase: Phase
    /**
     * Private rate, in milliseconds. `0` means every tick.
     *
     * Declared rather than computed from a tick count: `tick % 4` ties rate to
     * a counter instead of time, so any stall silently changes it, and
     * everything divisible by four fires together.
     */
    everyMs: number
    /**
     * The components this system reads and writes.
     *
     * There is no call graph in an ECS — systems never call each other — so
     * "what happens after this" has no answer. What replaces it is data
     * lineage: `arbitrate` reads `proposal` because `flee` wrote it. Declaring
     * it makes the lineage a THING a debugger can draw, rather than something a
     * reader reconstructs by grepping.
     *
     * Checked against the world's schema on the first run. Not enforced
     * against the body of `run` — but every write is stamped with the system
     * that made it, so a reader can see an undeclared write the moment it
     * happens.
     */
    reads: readonly ComponentType[]
    writes: readonly ComponentType[]
    run(ctx: Ctx): void
}

/** The one thing the schedule needs from a tick's context: the clock it gates rates on. */
export type SystemContext = {
    /** Wall clock for this tick. One value, so every system in a tick agrees on "now". */
    now: number
}

/**
 * The brackets a run is wrapped in — the host's ambient `phase` and `system`.
 *
 * Injected rather than reached for, so the scheduler is testable without a
 * live brain, and so the ambient globals are touched in exactly one place: the
 * cognet's own wiring.
 */
export type ScheduleTrace = {
    phase<T>(name: string, fn: () => Promise<T>): Promise<T>
    system<T>(name: string, fn: () => Promise<T>): Promise<T>
}

/** For one belief: who produces it and who consumes it. */
export type LineageEntry = {
    component: ComponentType
    writtenBy: string[]
    readBy: string[]
}
