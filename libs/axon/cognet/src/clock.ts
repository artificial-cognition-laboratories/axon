import { err } from "@arcforge/err"
import type { CognetTickComplete, CognetTickStart, KernelAbi } from "@arcforge/types"
import type { Stamp } from "./ecs"
import type { TicksT } from "./ticks"

/** Telemetry sink — the cognet's own `kernel.emit`. Fire-and-forget, never awaited. */
export type ClockEmit = KernelAbi["emit"]

export type ClockOpts = {
    emit: ClockEmit
    /**
     * The cognet's tick counter. Owned by the host because it outlives every
     * wake — see ticks.ts. A per-Clock counter reset to zero on each wake,
     * which made the tick number meaningless in continuous mode.
     */
    ticks: TicksT
    /**
     * The wake's own abort signal. Lets tick/phase/system tell an intentional
     * interrupt (Escape/Ctrl+C, engine abort) apart from a genuine failure.
     */
    signal?: AbortSignal
}

/**
 * Clock — the world clock and the execution wrappers that drive it.
 *
 * Every cognet has one, whether or not it holds a world: `phase()` and
 * `system()` are ambient globals, and the host wraps each loop iteration in a
 * tick. This is deliberately separate from the ECS so a cognet that never
 * queries an entity — a control loop, a perception stack — doesn't carry an
 * entity store it never touches.
 *
 * tick/phase/system are the ONLY writers of the clock. Each brackets its
 * callback with telemetry so the shape of a thought is recorded as it happens
 * rather than reconstructed afterward.
 *
 * Interrupt is a THIRD outcome, not a failure: when `signal` is aborted,
 * whatever fn() threw is cancellation surfacing through the call stack, not a
 * bug in the phase's own work. Emitting *:failed for that would conflate a
 * cancelled thought with a broken one, and telemetry full of meaningless red
 * is telemetry nobody reads. Real failures still emit *:failed and rethrow —
 * telemetry never swallows.
 */
export function Clock(opts: ClockOpts) {
    const { emit, signal, ticks } = opts

    let phase: string | null = null
    let system: string | null = null

    /**
     * Where in the thought an event happened — merged into every payload below
     * tick level, and into every world write.
     *
     * `system` is what turns a component write into lineage: without it a
     * reader sees that `fear` changed but not who changed it, and "who changes
     * this?" can only be answered by guessing from event order.
     */
    function stamp(): Stamp {
        return { tick: ticks.current(), phase: phase, system: system }
    }

    return {
        get tick() {
            return ticks.current()
        },
        // Annotated: without it the inferred return collapses to `null` (the
        // initializer's type), so a consumer comparing it to a phase name gets
        // a "no overlap" error for a comparison that is exactly the point.
        get phase(): string | null {
            return phase
        },
        get system(): string | null {
            return system
        },
        stamp,

        /**
         * One tick. Advances the clock. `opened` is what the tick answers,
         * when its schedule knows (see CognetTickStart); `fn` may note how it
         * was held, recorded when it completes.
         */
        async runTick<T>(fn: (note: (fields: Omit<CognetTickComplete, "tick">) => void) => Promise<T>, opened: Omit<CognetTickStart, "tick"> = {}): Promise<T> {
            const current = ticks.next()
            const started = Date.now()
            let noted: Omit<CognetTickComplete, "tick"> = {}
            void emit("cognet:tick:start", { tick: current, ...opened })
            try {
                const result = await fn(fields => { noted = { ...noted, ...fields } })
                void emit("cognet:tick:complete", { tick: current, durationMs: Date.now() - started, ...noted })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:tick:interrupted", { tick: current })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:tick:failed", { tick: current, error: failure, durationMs: Date.now() - started })
                throw failure
            }
        },

        /** A named stage within a tick. Sets the current phase for its duration. */
        async runPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
            phase = name
            const started = Date.now()
            void emit("cognet:phase:start", { tick: ticks.current(), phase: name })
            try {
                const result = await fn()
                void emit("cognet:phase:complete", { tick: ticks.current(), phase: name, durationMs: Date.now() - started })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:phase:interrupted", { tick: ticks.current(), phase: name })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:phase:failed", { tick: ticks.current(), phase: name, error: failure, durationMs: Date.now() - started })
                throw failure
            } finally {
                phase = null
            }
        },

        /**
         * A unit of work within a phase — the innermost bracket — recorded as
         * ONE `cognet:system:run` when it ends.
         *
         * `fn` is handed a `note` for what only the caller knows: the reads
         * it observed, the stimuli it consumed. `ran` replaces the bracket's
         * own timing for work done elsewhere — an async run that computed
         * beside the tick and is only LANDING here reports when it really ran.
         */
        async runSystem<T>(name: string, fn: (note: (fields: RunNote) => void) => Promise<T>, ran?: Ran): Promise<T> {
            // Restored rather than cleared: a system may bracket a sub-step as
            // a system of its own, and the outer one is still running after.
            const outer = system
            system = name
            const started = Date.now()
            let noted: RunNote = {}
            const record = (outcome: "complete" | "failed" | "interrupted", error?: ReturnType<typeof err>) => {
                void emit("cognet:system:run", {
                    ...stamp(),
                    system: name,
                    at: ran?.at ?? started,
                    durationMs: ran?.durationMs ?? Date.now() - started,
                    outcome: outcome,
                    ...(error ? { error: error } : {}),
                    ...(ran?.async ? { async: true as const } : {}),
                    ...(ran?.thread !== undefined ? { thread: ran.thread } : {}),
                    ...(ran?.lag ? { lag: ran.lag } : {}),
                    ...noted,
                })
            }
            try {
                const result = await fn(fields => { noted = { ...noted, ...fields } })
                record("complete")
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    record("interrupted")
                    throw cause
                }
                const failure = err(cause)
                record("failed", failure)
                throw failure
            } finally {
                system = outer
            }
        },
    }
}

export type ClockT = ReturnType<typeof Clock>

/**
 * A run computed somewhere other than inside its bracket: beside the tick
 * (`async`), on a worker thread (`thread`), or `lag` ticks before the one
 * it lands in. Its own timing replaces the bracket's, which only measured
 * the landing.
 */
export type Ran = { at: number; durationMs: number; async?: true; thread?: number; lag?: number }

/** What a system run's caller adds to its record. */
export type RunNote = {
    reads?: Array<{ entity: string; component: string; rev: number }>
    queries?: import("./ecs").QueryObservation[]
    inputs?: Array<{ seq: number; channel: string }>
}
