import { err } from "@arcforge/err"
import type { KernelAbi } from "@arcforge/types"

/** Telemetry sink — the cognet's own `kernel.emit`. Fire-and-forget, never awaited. */
export type ClockEmit = KernelAbi["emit"]

export type ClockOpts = {
    emit: ClockEmit
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
    const { emit, signal } = opts

    let tick = 0
    let phase: string | null = null

    /** tick/phase stamp merged into every event payload below tick level. */
    function stamp() {
        return { tick, phase }
    }

    return {
        get tick() {
            return tick
        },
        get phase() {
            return phase
        },
        stamp,

        /** One iteration of the cognitive loop. Advances the clock. */
        async runTick<T>(fn: () => Promise<T>): Promise<T> {
            tick += 1
            const current = tick
            const started = Date.now()
            void emit("cognet:tick:start", { tick: current })
            try {
                const result = await fn()
                void emit("cognet:tick:complete", { tick: current, durationMs: Date.now() - started })
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
            void emit("cognet:phase:start", { tick, phase: name })
            try {
                const result = await fn()
                void emit("cognet:phase:complete", { tick, phase: name, durationMs: Date.now() - started })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:phase:interrupted", { tick, phase: name })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:phase:failed", { tick, phase: name, error: failure, durationMs: Date.now() - started })
                throw failure
            } finally {
                phase = null
            }
        },

        /** A unit of work within a phase — the innermost bracket. */
        async runSystem<T>(name: string, fn: () => Promise<T>): Promise<T> {
            const started = Date.now()
            void emit("cognet:system:start", { ...stamp(), system: name })
            try {
                const result = await fn()
                void emit("cognet:system:complete", { ...stamp(), system: name, durationMs: Date.now() - started })
                return result
            } catch (cause) {
                if (signal?.aborted) {
                    void emit("cognet:system:interrupted", { ...stamp(), system: name })
                    throw cause
                }
                const failure = err(cause)
                void emit("cognet:system:failed", { ...stamp(), system: name, error: failure, durationMs: Date.now() - started })
                throw failure
            }
        },
    }
}

export type ClockT = ReturnType<typeof Clock>
