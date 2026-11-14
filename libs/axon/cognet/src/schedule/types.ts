import type { AxonStimulusEntry, CognetTickComplete, CognetTickStart } from "@arcforge/types"
import type { Component, Definition, QueryObservation, Read, StateT, Written } from "../ecs"
import type { Streamed } from "./access"
import type { Input } from "./input"
import type { Ran, RunNote } from "../clock"
import type { RunServices } from "../services"

/** What the host hands the schedule each tick. */
export type Tick = {
    /** Wall clock for this tick. One value, so every system in a tick agrees on "now". */
    now: number
    /** Stimuli that arrived with this tick's wake — buffered until each reader runs. */
    stimuli: readonly AxonStimulusEntry[]
    /** The wake's cancellation. An async run started this tick inherits it. */
    signal: AbortSignal
    /** A replay's: the async systems whose runs land at this tick, as they did live (see CognetWake.lands). */
    lands?: readonly string[]
}

/** What a system run receives. Everything else is ambient (`ecs`, `kernel`). */
export type Run = {
    /** Wall clock for this tick. */
    now: number
    /**
     * Every stimulus since this system last ran. Only for a system that
     * declares `reads: [stimuli]` — reading it otherwise throws.
     */
    stimuli: readonly AxonStimulusEntry[]
    /**
     * The wake's cancellation. Engine calls and capsule runs honour it on
     * their own; an async run with work of its own between awaits checks it.
     */
    signal: AbortSignal
    /**
     * Every value written to `handle` since this system last ran, oldest
     * first. Only for a component the system declares in `streams` — asking
     * for another throws.
     */
    since<T>(handle: Component<T>): readonly Written<T>[]
    /**
     * The services its system declared in `uses`, by the names the cognet
     * gave them — each method of its interface a function. Reaching one it
     * did not declare throws; calling one needs an `async` system.
     */
    services: RunServices
}

/** Anything a system may name in `reads` or `recalls`. */
export type Readable = Definition | Input

/** Anything a system may be run by: what it reads, or the clock. */
export type Trigger = Definition | Input

/**
 * One system: what it touches, how often it runs, and the run itself.
 *
 * There is no call graph in an ECS — systems never call each other — so the
 * declared data IS the program's structure. The schedule orders every system
 * from it, checks it before the first run, and enforces it on every run.
 */
export type SystemSpec = {
    /**
     * What makes this run. A system runs in a tick only when something that
     * runs it has changed since it last ran — never on a tick when nothing
     * did, and at most once a tick however much did.
     *
     * Absent: what it `reads` runs it — a new frame, a changed belief, a
     * stimulus for it. Present: ONLY these do, and its reads are simply what
     * it uses. How a mind paces its own work: depth `on: [beats.depth]`
     * reads `sight` but runs when the mind's beat for depth changes, at
     * whatever rate the mind writes it.
     *
     * `clock` runs it every tick: for what must notice time passing — a
     * silence, a fade, a hold — though nothing it reads has changed.
     *
     * A trigger orders like a read: whoever writes it runs first.
     */
    on?: readonly Trigger[]
    /** Run on the first tick only. */
    once?: boolean
    /** This tick's values: every system that writes one runs first. Components, queries, or `stimuli`. */
    reads?: readonly Readable[]
    /**
     * Last tick's values: no ordering edge. How a feedback loop is declared —
     * `flow` seeding its search from the `egomotion` that flow itself feeds.
     */
    recalls?: readonly Definition[]
    /**
     * Every value written since this system last ran, in the order written —
     * `run.since(handle)` — where `reads` gives only the latest. For what is
     * written more often than its reader runs and must not be lost between:
     * an inner ear integrated reading by reading, read by a system that runs
     * on a beat, or lags. Orders like a read, and runs the system like one
     * when it names no `on`.
     */
    streams?: readonly Component<any>[]
    writes?: readonly Component<any>[]
    /**
     * The services it calls, by the names the cognet gave them in
     * `cognet.config.ts`. Its run's `services` holds these and no others, so
     * which systems depend on a model is part of the declared data, like
     * what they read. Calls need an answer, so only an `async` system makes
     * them; any system may read whether a use is available.
     */
    uses?: readonly string[]
    /**
     * `"worker"`: run on a worker thread, beside other systems the declared
     * data says it cannot see. Results are the same as on the main thread —
     * it still completes inside its tick, before anything that reads what it
     * writes — so this is purely where the time is spent.
     *
     * For heavy, pure systems: a worker run is synchronous, reads only its
     * declared components, and has no `kernel`. The world it reads is copied
     * to the worker, so a run that does little work on a lot of data is
     * cheaper left on the main thread.
     */
    thread?: "worker"
    /**
     * Ticks between when a run starts and when its writes land. Absent or 0:
     * they land in the tick it ran in, before anything that reads them — the
     * default, and the only way a reader sees this tick's value. `n`: it
     * starts on a snapshot of what it declared, the tick carries on without
     * it, and its writes land at the start of the tick `n` later, before any
     * system runs. Readers see its values `n` ticks old, every time — the
     * tick it lands in is counted, never timed, so a replay sees exactly what
     * the live mind saw.
     *
     * For work longer than a tick that must not hold every tick up: on a
     * worker, it runs while the next ticks run. Not run again until it has
     * landed — what it streams waits for it. A run still going when its tick
     * comes is waited for, and recorded as an overrun.
     */
    lag?: number
    /**
     * The run. Synchronous by default: it completes inside the tick.
     *
     * `async run()` makes it an ASYNC system. The tick does not wait for it:
     * it reads a snapshot taken when it starts, its writes are buffered and
     * land at the start of the next tick after it resolves, and it is not
     * started again while a run is in flight.
     */
    run(run: Run): void | Promise<void>
}

export type System = Readonly<SystemSpec> & { readonly kind: "system" }

/** Authoring accepts names; discovery resolves them before a system enters the schedule. */
export type AuthoredSystemSpec = Omit<SystemSpec, "on" | "reads" | "recalls" | "streams" | "writes"> & {
    on?: readonly (Trigger | string)[]
    reads?: readonly (Readable | string)[]
    recalls?: readonly (Definition | string)[]
    streams?: readonly (Component<any> | string)[]
    writes?: readonly (Component<any> | string)[]
}

export type AuthoredSystem = Readonly<AuthoredSystemSpec> & { readonly kind: "system" }

/** A system with the name the compile step gave it — its path under the cognet, minus `.system.ts`. */
export type NamedSystem = {
    name: string
    system: System
}

/**
 * The bracket each run is wrapped in — the host's ambient `system`.
 *
 * Injected so the scheduler is testable without a live brain, and so the
 * ambient globals are touched in exactly one place.
 */
export type ScheduleTrace = {
    /** See Clock.runTick: one tick, opened with what it answers; `fn` may note how it was held. */
    tick<T>(fn: (note: (fields: Omit<CognetTickComplete, "tick">) => void) => Promise<T>, opened: Omit<CognetTickStart, "tick">): Promise<T>
    /** See Clock.runSystem: `fn` may note what it observed; `ran` is an async run's own timing. */
    system<T>(name: string, fn: (note: (fields: RunNote) => void) => Promise<T>, ran?: Ran): Promise<T>
}

/** For one component: who produces it and who consumes it. */
export type LineageEntry = {
    component: string
    writtenBy: string[]
    readBy: string[]
    /** Systems that read it as every value written since they last ran. */
    streamedBy: string[]
    /** Systems it runs: named in their `on`. */
    runs: string[]
    recalledBy: string[]
}

/**
 * Where `thread: "worker"` systems run — injected, so the schedule decides
 * WHEN a system may run and never knows how threads work.
 */
export type ScheduleThreads = {
    /** Worker threads available. 0: worker systems run on the main thread, in order. */
    readonly size: number
    /**
     * Run one system on a worker. Rejects when the run throws or the worker
     * fails. `from` is the world as it stood when the run was started — a
     * lagged run's, which the systems after it may change before a worker is
     * free to take it. Absent: the live world when a worker takes it, which
     * nothing the run reads can have changed meanwhile.
     */
    run(entry: NamedSystem, given: { now: number; streams: Streamed; from?: StateT }): Promise<ThreadResult>
}

/** A worker run, back on the main thread and waiting to land. Exactly one of commit or discard is called. */
export type ThreadResult = {
    /** What the run read, by rev. */
    reads: Read[]
    queries: QueryObservation[]
    /** When and where it ran. */
    ran: Ran
    /** Apply its writes to the live world. Inside the system's trace bracket, so they are attributed to it. */
    commit(): void
    /** Drop its writes: the tick it belonged to failed before it could land. */
    discard(): void
}

/**
 * A run's services, and how they end — injected by the host, which holds the
 * kernel. `calls` says whether the run may make calls: only an async one can.
 */
export type ScheduleServices = (entry: NamedSystem, calls: boolean) => { services: RunServices; end(): Promise<void> }
