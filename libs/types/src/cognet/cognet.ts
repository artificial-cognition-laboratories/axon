import type { AxonBlueprint } from "../blueprint"
import type { KernelAbi, CognetWake } from "../kernel/abi"
import type { AxonEntryEvent } from "../session/events/entries"

/**
 * A cognet definition — one cognition artifact, what defineCognet()
 * produces. Built as its own project (registry/cognets/*), bundled by the CLI, and
 * carried into the runtime on blueprint.cognet — there is NO other way to
 * load a brain. Resident for the runtime's lifetime: the kernel loads it
 * once (exec), delivers wakes, and owns the execution record around every
 * wake.
 *
 * The definition owns everything inside: grammar, context rendering,
 * strategy, its own derived state (a cache of the log, rebuildable — never
 * authoritative). It touches nothing but the ABI it receives at load().
 */
/**
 * How the scheduler decides to invoke this cognet. Part of the cognet's own
 * declared identity — never blueprint-overridable, same trust direction as
 * `abi`: a cognet built for invocation-based wakes was never written to
 * tolerate an empty-stimuli tick, so an agent author can't flip this from
 * outside.
 *
 * - "invocation" — invoked once per admitted stimulus arrival, handed the
 *   full diff accumulated since the last invocation (may be more than one
 *   stimulus if several arrived while the previous wake was running).
 * - "continuous" — invoked on a fixed clock regardless of whether anything
 *   arrived; an empty diff is the ordinary steady state, not an edge case.
 */
export type CognetSchedule =
    | { kind: "invocation" }
    | { kind: "continuous"; tickMs: number }

/**
 * Cognet identity — what cognet.config.ts declares via defineCognet().
 * The compiled artifact composes this with the loop the entry script
 * registers; identity and behavior never live in the same file.
 */
export type CognetConfig = {
    name: string
    version: string

    /** The kernel ABI version this cognet was built against — checked at load, mismatch refuses loudly. */
    abi: string

    /** How the scheduler invokes this cognet. */
    mode: CognetSchedule

    /** Default wake mask — overridable by the blueprint's wakeOn. Absent = wake on everything. */
    wakeOn?: Array<keyof AxonEntryEvent>

    /** Hard safety bound for one wake. Strategy may stop earlier; default is 8 ticks. */
    maxTicksPerWake?: number
}

export type CognetDefinition = CognetConfig & {

    /** exec(): receives the syscall table. Runs once, before any wake. */
    load(kernel: KernelAbi): Promise<void> | void

    /** One scheduled episode. Returns when quiescent; throws on failure. */
    wake(wake: CognetWake): Promise<void>

    /** The agent changed (hot reload) — adopt the new blueprint before the next wake. */
    update?(blueprint: AxonBlueprint): void

    /** Brain off. Nothing durable to flush — durable writes already happened at commit time. */
    unload?(): Promise<void> | void
}
