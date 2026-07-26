import { err } from "@axon/err"
import type { AxonHandle } from "@arcforge/types"
import type { StateT } from "./state"
import type { EcsEmit } from "./ecs"

type LoopOpts = {
    state: StateT
    emit: EcsEmit
    /** The wake's own abort signal — lets tick/phase/system tell an intentional interrupt (Escape/Ctrl+C, engine abort) apart from a genuine failure. Optional only for callers that predate wiring it (none currently); every real wake has one. */
    signal?: AbortSignal
}

/**
 * Loop — the execution wrappers that drive the world clock.
 * tick/phase/system are the only writers of state.tick and state.phase;
 * each brackets its callback with kernel telemetry on the runtime bus.
 *
 * Interrupt is a THIRD outcome, not a failure: when `signal` is aborted,
 * whatever fn() threw (an AbortError, an engine's own throw, anything) is
 * cancellation surfacing through the call stack, not a bug in the phase's
 * own work. Emitting cognet:*:failed for that would be the same mistake
 * kernel/scheduler/wake.ts already avoids at the run level (its own
 * abort.signal.aborted check) — this is the same rule one layer down,
 * where individual ticks/phases/systems can also observe the abort mid-fn.
 * Real failures still emit *:failed and rethrow — telemetry never swallows.
 */
export function Loop(opts: LoopOpts) {
    const { state, emit, signal } = opts

    return {
        /** One iteration of the cognitive loop. Advances the world clock. */
        async tick<T = any>(fn: () => Promise<T>): Promise<T> {
            const tick = state.nextTick()
            void emit("cognet:tick:start", { tick })
            try {
                const result = await fn()
                void emit("cognet:tick:complete", { tick })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:tick:interrupted", { tick })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:tick:failed", {
                    tick: tick,
                    error: failure,
                })
                throw failure
            }
        },

        /** A named stage within a tick. Sets state.phase for the duration. */
        async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
            state.setPhase(name)
            void emit("cognet:phase:start", { tick: state.tick, phase: name })
            try {
                const result = await fn()
                void emit("cognet:phase:complete", { tick: state.tick, phase: name })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:phase:interrupted", { tick: state.tick, phase: name })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:phase:failed", {
                    tick: state.tick,
                    phase: name,
                    error: failure,
                })
                throw failure
            } finally {
                state.setPhase(null)
            }
        },

        /** A unit of work within a phase. Timed for the flame graph. */
        async system<T>(name: string, fn: () => Promise<T>): Promise<T> {
            const started = Date.now()
            void emit("cognet:system:start", {
                ...state.stamp(),
                system: name,
            })
            try {
                const result = await fn()
                void emit("cognet:system:complete", {
                    ...state.stamp(),
                    system: name,
                    durationMs: Date.now() - started,
                })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:system:interrupted", { ...state.stamp(), system: name })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:system:failed", {
                    ...state.stamp(),
                    system: name,
                    error: failure,
                })
                throw failure
            }
        },
    }
}

export type LoopT = ReturnType<typeof Loop>
