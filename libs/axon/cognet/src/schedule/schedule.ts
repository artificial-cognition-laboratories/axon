import type { EcsEmit, EcsT } from "../ecs"
import { Lineage } from "./lineage"
import type { ScheduleTrace, SystemContext, SystemSpec } from "./types"

export type ScheduleOpts<Ctx extends SystemContext> = {
    /**
     * The world the systems run in. The schedule checks lineage against its
     * schema, and observes each run through it to record what was read.
     */
    ecs: EcsT
    systems: readonly SystemSpec<Ctx, string>[]
    /** Where the schedule declares itself. The cognet's own `kernel.emit`. */
    emit: EcsEmit
    trace: ScheduleTrace
}

/**
 * Schedule — one clock, many private rates, and the shape of the mind.
 *
 * The body has one sample rate; the mind does not. Perception can afford to
 * run every tick, a drive need not, and a deliberating layer must not. So the
 * loop ticks at the fastest rate anything needs and each system declares when
 * it is due, computed from wall clock so a slow tick cannot drift a rate.
 *
 * Systems run in declared order, grouped into phases in the order they first
 * appear. Ordering is explicit because the whole point of a one-way pipeline is
 * that a reader can see it.
 *
 * On the first run the schedule checks its lineage against the world and then
 * DECLARES itself — every system, its phase, rate, reads and writes — so a
 * debugger can draw the data graph without knowing anything about this mind.
 * That happens at first run rather than construction: building a schedule is
 * wiring, and the world it checks against may still be declaring.
 *
 * Every run is OBSERVED: the exact values a system read are emitted after
 * it, so each write it made has recorded causal parents. Declared reads say
 * what a system may look at; observed reads say what it did.
 *
 * Anything that can outlast a tick does NOT belong here. A deliberating layer
 * or a perception model runs asynchronously and writes its conclusion back
 * into the world when it lands; putting it on this clock would stall the body
 * waiting for a thought.
 */
export function Schedule<Ctx extends SystemContext>(opts: ScheduleOpts<Ctx>) {
    const { ecs, systems, emit, trace } = opts
    const lineage = Lineage({ schema: ecs.schema, systems: systems })
    const lastRun = new Map<string, number>()
    let declared = false

    return {
        /** Every system, with its rate — the shape of the mind, for a reader. */
        get systems() {
            return systems
        },

        lineage: lineage,

        async run(ctx: Ctx): Promise<void> {
            if (!declared) {
                lineage.check()
                void emit("cognet:schedule:declare", lineage.declaration())
                declared = true
            }

            const due = systems.filter(spec => {
                const previous = lastRun.get(spec.name)
                return previous === undefined || ctx.now - previous >= spec.everyMs
            })

            // Grouped so a phase is ONE bracket containing the systems that ran
            // inside it. Opening a phase per system would make the flame graph
            // a flat list of identically-named brackets.
            for (const group of consecutiveByPhase(due)) {
                for (const spec of group.systems) lastRun.set(spec.name, ctx.now)

                await trace.phase(group.phase, async () => {
                    for (const spec of group.systems) {
                        await trace.system(spec.name, async () => {
                            const { reads } = ecs.observe(() => spec.run(ctx))
                            // Named explicitly rather than taken from the stamp: a
                            // trace that does not track systems (a test's
                            // passthrough) must not orphan the reads.
                            void emit("cognet:system:reads", { ...ecs.state.stamp(), system: spec.name, reads: reads })
                        })
                    }
                })
            }
        },
    }
}

export type ScheduleT<Ctx extends SystemContext = SystemContext> = ReturnType<typeof Schedule<Ctx>>

/** Runs of adjacent systems sharing a phase, in declared order. */
function consecutiveByPhase<S extends { phase: string }>(systems: readonly S[]): Array<{ phase: string; systems: S[] }> {
    const groups: Array<{ phase: string; systems: S[] }> = []

    for (const spec of systems) {
        const last = groups.at(-1)
        if (last && last.phase === spec.phase) last.systems.push(spec)
        else groups.push({ phase: spec.phase, systems: [spec] })
    }

    return groups
}
