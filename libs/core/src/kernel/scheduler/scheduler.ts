import { err } from "@axon/err"
import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { AxonBusT } from "../../platform/bus"
import type { AxonSessionT } from "../session"
import type { CognetT } from "../../cognet/cognet"
import { Wake } from "./wake"
import { Invocation } from "./invocation"
import { Continuous } from "./continuous"

type SchedulerOpts = {
    bus: AxonBusT
    session: AxonSessionT
}

type InvokeInput = {
    /** User message committed before the invoke starts. */
    content?: string | string[]
}

/**
 * Scheduler — the kernel's process manager. Decides WHEN cognet.wake() is
 * called and WHAT diff it's handed; owns nothing about HOW a wake executes
 * once started (that's wake.ts, unchanged regardless of trigger source).
 *
 * Two trigger sources, one mechanism: invocation.ts fires on an admitted
 * stimulus, continuous.ts fires on a clock — both call the same internal
 * runWake(), which drains session.stimuli and hands the diff to Wake().
 * Neither trigger source knows the other exists; the cognet's declared
 * `mode` picks which one is wired up.
 *
 * SCHEDULING POLICY (policy, not physics — revisit without contract change):
 * one wake at a time, globally. A concurrent invoke throws RUN_IN_PROGRESS.
 */
export function Scheduler(opts: SchedulerOpts) {
    let cognet: CognetT | null = null
    let active: { runId: string } | null = null
    let reservation: { id: string; abort: AbortController } | null = null

    /**
     * Reserve the scheduler SYNCHRONOUSLY, at the true call boundary — an
     * async generator's body doesn't run until iterated, so locking inside
     * would leave a window where two callers both mint a wire.
     */
    function reserve(): string {
        if (reservation) throw err("RUN_IN_PROGRESS")
        const id = Bun.randomUUIDv7()
        reservation = { id, abort: new AbortController() }
        return id
    }

    function release(id?: string): void {
        if (id !== undefined && reservation?.id !== id) return
        active = null
        reservation = null
    }

    /**
     * Run one wake as an already-reserved execution, handed a stimuli diff.
     * Both trigger sources call this identically — it has no idea whether a
     * stimulus or a clock caused it to be called.
     */
    function runWake(reservationId: string, input: { stimuli: AxonStimulusEntry[] }): AsyncGenerator<AxonEntry> {
        if (reservation?.id !== reservationId) throw err("RUN_RESERVATION_EXPIRED")
        if (!cognet) {
            release(reservationId)
            throw err("NO_COGNET_LOADED")
        }

        const wake = Wake({
            cognet,
            stimuli: input.stimuli,
            bus: opts.bus,
            session: opts.session,
            abort: reservation.abort,
        })
        active = { runId: wake.runId }

        return (async function* () {
            try {
                // Every pull re-enters the wake body under the session's
                // error scope: an async generator resumes in its CALLER's
                // async context (the host consuming the stream), not its
                // creation context, so wrapping creation alone would leak
                // wake-time err() calls out of attribution. Scoping each
                // next() means everything the wake executes — cognet code,
                // engine calls, ABI syscalls — attributes to this session.
                const inner = wake.stream()
                while (true) {
                    const result = await opts.session.scope(() => inner.next())
                    if (result.done) return
                    yield result.value
                }
            } finally {
                release(reservationId)
            }
        })()
    }

    /** abort the active wake, if any — safe to call when idle */
    function interrupt(reason: "user" | "shutdown" = "user", reservationId?: string) {
        if (reservationId !== undefined && reservation?.id !== reservationId) return
        reservation?.abort.abort(reason)
    }

    const invocation = Invocation({ session: opts.session, reserve, release, runWake, interrupt })
    const continuous = Continuous({ session: opts.session, reserve, release, runWake })

    return {
        get loaded() {
            return cognet !== null
        },

        /** register the loaded cognet — the kernel runs load(abi) first */
        attach(next: CognetT) {
            cognet = next
            if (next.mode.kind === "continuous") continuous.start(next.mode.tickMs)
        },

        /** Invoke on a stimulus admission (invocation mode) — no-op shape for continuous cognets, which never call this. */
        stream(input: InvokeInput = {}) {
            if (!cognet) throw err("NO_COGNET_LOADED")
            if (cognet.mode.kind === "continuous") {
                throw err("SCHEDULER_MODE_MISMATCH", { detail: "continuous cognets are invoked by the scheduler's own clock, never by stream()" })
            }
            return invocation.stream(input)
        },

        /**
         * The currently running wake's correlation — run addressing is
         * ambient, resolved here rather than passed by the cognet (there's
         * no session/thread on the ABI for it to address by hand). Every
         * syscall the ABI exposes (output, run, stream) reads this.
         */
        active() {
            if (!active) throw err("SYSCALL_OUTSIDE_RUN")
            return active
        },

        /** Like active(), but null outside a wake instead of throwing — for emitters (cognet telemetry) that legally fire during load/unload. */
        current() {
            return active
        },

        interrupt,

        /** stop the continuous clock, if running — called on kernel shutdown/reload */
        stop() {
            continuous.stop()
        },
    }
}

export type SchedulerT = ReturnType<typeof Scheduler>
