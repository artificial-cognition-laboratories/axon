import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"
import type { AxonEntry, AxonStimulusEntry } from "@arcforge/types"
import type { KernelBus } from "../contracts"
import type { AxonSessionT } from "@arcforge/session"
import type { KernelCognet } from "../contracts"
import { Wake } from "./wake"
import { Invocation } from "./invocation"
import { Continuous } from "./continuous"

type SchedulerOpts = {
    bus: KernelBus
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
 * stimulus, continuous.ts fires when the BRAIN wakes itself — both call the
 * same internal runWake(), which drains session.stimuli and hands the diff to
 * Wake(). Neither trigger source knows the other exists; the cognet's
 * declared `mode` picks which verb is legal against it.
 *
 * Note the clock is NOT here, and not in the body either. A continuous cognet
 * is advanced by a cognet plugin calling kernel.wake(); the scheduler owns
 * what happens on contention, never when a wake occurs.
 *
 * SCHEDULING POLICY, and it differs by mode because the modes differ:
 *
 *   invocation — one wake at a time. An invocation cognet IS one
 *   conversation, so a concurrent invoke is a caller error: RUN_IN_PROGRESS.
 *
 *   continuous — wakes overlap, always. Every wake starts however long the
 *   last one is still taking, because stimuli are transient: a skipped wake
 *   is not a late wake, it is one that never heard. See continuous.ts.
 */
/**
 * The run a syscall belongs to, resolved per async context.
 *
 * Every ABI syscall stamps its commit with the current runId, and that used
 * to be one module-level `active` — which held for a serial scheduler and
 * breaks the moment two wakes overlap: the second overwrites it, so the
 * first's outputs attribute to the wrong run, and when either finishes the
 * other's syscalls throw SYSCALL_OUTSIDE_RUN mid-flight.
 *
 * AsyncLocalStorage binds it to the wake that started the work, so a syscall
 * resolves correctly no matter how the awaits interleave.
 */
const runStorage = new AsyncLocalStorage<{ runId: string; signal: AbortSignal }>()

export function Scheduler(opts: SchedulerOpts) {
    let cognet: KernelCognet | null = null
    /**
     * Live wakes, by reservation id. A count rather than a single slot: a
     * continuous cognet ticks whether or not the last wake finished, and
     * blocking there is deafness, not backpressure — the stimuli a skipped
     * tick would have carried are already gone.
     */
    const live = new Map<string, { abort: AbortController }>()
    let reservation: { id: string; abort: AbortController } | null = null

    /**
     * Reserve the scheduler SYNCHRONOUSLY, at the true call boundary — an
     * async generator's body doesn't run until iterated, so locking inside
     * would leave a window where two callers both mint a wire.
     *
     * `exclusive` is what separates the two modes. An invocation cognet IS
     * one conversation, so a second concurrent invoke is a caller error and
     * still throws RUN_IN_PROGRESS. A continuous cognet is a mind under a
     * clock: wakes overlap by design, because deliberation that outlasts a
     * tick must not stop the next tick from hearing.
     */
    function reserve(opts?: { exclusive?: boolean }): string {
        if (opts?.exclusive !== false && reservation) throw err("RUN_IN_PROGRESS")
        const id = Bun.randomUUIDv7()
        const entry = { id, abort: new AbortController() }
        live.set(id, entry)
        if (opts?.exclusive !== false) reservation = entry
        return id
    }

    function release(id?: string): void {
        if (id === undefined) {
            live.clear()
            reservation = null
            return
        }
        live.delete(id)
        if (reservation?.id === id) reservation = null
    }

    /**
     * Run one wake as an already-reserved execution, handed a stimuli diff.
     * Both trigger sources call this identically — it has no idea whether a
     * stimulus or a clock caused it to be called.
     */
    function runWake(reservationId: string, input: { stimuli: AxonStimulusEntry[] }): AsyncGenerator<AxonEntry> {
        const reserved = live.get(reservationId)
        if (!reserved) throw err("RUN_RESERVATION_EXPIRED")
        if (!cognet) {
            release(reservationId)
            throw err("NO_COGNET_LOADED")
        }

        const wake = Wake({
            cognet,
            stimuli: input.stimuli,
            bus: opts.bus,
            session: opts.session,
            abort: reserved.abort,
        })
        // The signal rides WITH the run, so a mediated syscall resolves its
        // own wake's cancellation rather than being handed one. A cognet
        // that forgot to thread it used to make an operation unkillable;
        // there is now nothing to forget.
        const run = { runId: wake.runId, signal: reserved.abort.signal }

        return (async function* () {
            try {
                // Every pull re-enters the wake body under the session's
                // error scope: an async generator resumes in its CALLER's
                // async context (the host consuming the stream), not its
                // creation context, so wrapping creation alone would leak
                // wake-time err() calls out of attribution. Scoping each
                // next() means everything the wake executes — cognet code,
                // engine calls, ABI syscalls — attributes to this session.
                //
                // runStorage wraps it for the same reason one ring in: the
                // run a syscall belongs to must be resolved from the async
                // context that is executing, not from a module variable the
                // next overlapping wake would have overwritten.
                const inner = wake.stream()
                while (true) {
                    const result = await runStorage.run(run, () => opts.session.scope(() => inner.next()))
                    if (result.done) return
                    yield result.value
                }
            } finally {
                release(reservationId)
            }
        })()
    }

    /**
     * Abort a wake, or every live wake — safe to call when idle.
     *
     * Without an id this aborts ALL of them, which is what shutdown and a
     * user interrupt both mean: stop thinking. With overlapping wakes there
     * is no single "the active wake" to target, and aborting only the newest
     * would leave older deliberation running past the interrupt that was
     * meant to end it.
     */
    function interrupt(reason: "user" | "shutdown" = "user", reservationId?: string) {
        if (reservationId !== undefined) {
            live.get(reservationId)?.abort.abort(reason)
            return
        }
        for (const entry of live.values()) entry.abort.abort(reason)
    }

    const invocation = Invocation({ session: opts.session, reserve, release, runWake, interrupt })
    const continuous = Continuous({ session: opts.session, reserve, release, runWake })

    /**
     * Wake an invocation cognet when the WORLD reaches it — the trigger that
     * makes `mode: "invocation"` mean what its docstring says ("invoked once
     * per admitted stimulus arrival") for a stimulus nobody called in.
     *
     * Without this the only path to a wake was kernel.stream()/request(), so
     * a stimulus from a sense organ (a channel module, a sensor) queued and
     * waited for a caller that never came: the message landed in the log and
     * the agent never thought about it. A body has no caller by definition.
     *
     * Three gates, and each rejects for its own reason:
     *
     *   MODE — continuous cognets own their clock (a cognet plugin drives
     *   kernel.wake()); waking them here would be the runtime asserting a
     *   rhythm it cannot know, which continuous.ts exists to prevent.
     *
     *   PROVENANCE — a stimulus committed BY a wake is that wake's own echo.
     *   Waking on it is an infinite loop: the brain hears itself and thinks
     *   again, forever. runStorage answers this exactly — anything ingested
     *   inside a wake carries that wake's async context.
     *
     *   MASK — `wakeOn`, when the cognet declares one. Absent means wake on
     *   everything, which is the right default for a conversational brain
     *   and wrong for one that only cares about a single channel.
     *
     * Contention is NOT a gate: an invocation cognet is one conversation, so
     * a stimulus arriving mid-wake is dropped by reserve() throwing
     * RUN_IN_PROGRESS. That is correct — it stays on the queue and the
     * running wake's own drain picks it up.
     */
    function onStimulus(entry: AxonStimulusEntry): void {
        if (!cognet || cognet.mode.kind !== "invocation") return

        // The brain's own echo — never wake on it.
        if (runStorage.getStore()) return

        const mask = cognet.wakeOn
        if (mask && !mask.includes(entry.type)) return

        let wire: ReturnType<typeof invocation.stream>
        try {
            wire = invocation.stream()
        } catch {
            // RUN_IN_PROGRESS: a wake is already running and will drain this
            // stimulus itself. Nothing is lost, so nothing to report.
            return
        }

        // The wire MUST be consumed to completion or its reservation leaks
        // (runWake's finally lives inside the generator). Detached because
        // no caller is waiting — a sensation is not a question. Entries
        // commit as they are produced.
        void (async () => {
            for await (const _entry of wire.stream) {
                // nothing to collect
            }
        })().catch(() => {
            // Already durable as kernel:run:failed by the time it lands here.
        })
    }

    // Stimuli reach the bus on every ingest (durable and transient alike —
    // session.ts forwards both), so this is the arrival signal without
    // threading a second callback through the session's queue. Subscribed
    // for the scheduler's lifetime: onStimulus itself gates on whether a
    // cognet is attached and what mode it is in.
    const unsubscribe = opts.bus.onAny((event, payload) => {
        if (!event.startsWith("cognet:stimulus:")) return
        onStimulus(payload as AxonStimulusEntry)
    })

    return {
        get loaded() {
            return cognet !== null
        },

        /** Drop the bus subscription — run when the kernel shuts down. */
        dispose() {
            unsubscribe()
        },

        /** register the loaded cognet — the kernel runs load(abi) first */
        attach(next: KernelCognet) {
            cognet = next
        },

        /**
         * Forget the cognet — the counterpart to attach(), run when the brain
         * is unloaded.
         *
         * `attach` had no opposite, so `loaded` stayed true after a shutdown
         * or a failed reload: the scheduler still held a reference to a brain
         * that could no longer wake, and readiness reported healthy for an
         * agent with nothing to think with.
         */
        detach() {
            cognet = null
        },

        /**
         * Advance a continuous cognet by one wake. The clock belongs to the
         * BRAIN — a cognet plugin driving `kernel.wake()` — never to this
         * scheduler and never to the body. See KernelAbi.wake.
         *
         * Resolves with the wake's ordinal on admission, not completion.
         */
        wake() {
            if (!cognet) throw err("NO_COGNET_LOADED")
            if (cognet.mode.kind !== "continuous") {
                throw err("SCHEDULER_MODE_MISMATCH", { detail: "wake() drives continuous cognets; an invocation cognet wakes on a stimulus via stream()" })
            }
            return continuous.wake()
        },

        /** A snapshot of the scheduler's clock — see KernelClock. */
        clock() {
            return { wakes: continuous.wakes }
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
            const run = runStorage.getStore()
            if (!run) throw err("SYSCALL_OUTSIDE_RUN")
            return run
        },

        /** Like active(), but null outside a wake instead of throwing — for emitters (cognet telemetry) that legally fire during load/unload. */
        current() {
            return runStorage.getStore() ?? null
        },

        interrupt,
    }
}

export type SchedulerT = ReturnType<typeof Scheduler>
