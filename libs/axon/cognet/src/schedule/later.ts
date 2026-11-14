import { err } from "@arcforge/err"
import type { Ran } from "../clock"
import type { EcsEmit, EcsT, QueryObservation, Read } from "../ecs"
import { access } from "./access"
import type { NamedSystem, Run, ScheduleTrace } from "./types"

export type LaterOpts = {
    /** The world a run is isolated from, and lands in. */
    ecs: EcsT
    emit: EcsEmit
    trace: ScheduleTrace
}

/** How a run that lands later ended: its writes, ready to apply; why it failed; or that its wake cancelled it. */
export type Outcome =
    | { kind: "landed"; entry: NamedSystem; commit(): void | Promise<void>; reads: Read[]; queries: QueryObservation[]; ran: Ran }
    | { kind: "failed"; entry: NamedSystem; cause: unknown; ran: Ran }
    | { kind: "cancelled"; entry: NamedSystem; ran: Ran }

/**
 * Later — the runs whose writes land in a later tick than the one they
 * started in, and their landing.
 *
 * Two kinds, one landing. An ASYNC run lands at the first tick boundary
 * after it settles — when the machine is done with it, so where is a matter
 * of timing (a replay running a session as it ran names where, instead). A
 * LAGGED run lands at the start of the tick its lag counts to, however soon
 * it finished — counted, never timed — and one still going then is waited
 * for: an overrun, recorded, with the tick it held up.
 *
 * Either way it lands at the start of a tick, before any system runs, inside
 * its own trace bracket, so no tick ever sees half a result. A system with a
 * run still to land is not started again: backpressure, with nothing for the
 * author to write. A failed run fails the tick it lands in, after every other
 * result has landed.
 */
export function Later(opts: LaterOpts) {
    const { ecs, emit, trace } = opts
    /** Runs still to land, by system — at most one each. `due` is a lagged run's tick; null, an async run's. */
    const pending = new Map<string, Pending>()
    /** Async runs that have settled, waiting for a tick boundary. */
    const ready: Array<{ outcome: Outcome; owner: AbortSignal }> = []

    function hold(entry: NamedSystem, owner: AbortSignal, settled: Promise<Outcome>, due: number | null): void {
        const one: Pending = { entry: entry, owner: owner, settled: settled, done: false, due: due }
        pending.set(entry.name, one)
        if (due === null) working()
        void settled.then(outcome => {
            one.done = true
            if (due !== null) return
            pending.delete(entry.name)
            ready.push({ outcome: outcome, owner: owner })
            working()
        })
    }

    /** Say what is in flight beside the ticks — the async runs, not the lagged ones, which land by tick count. */
    function working(): void {
        void emit("cognet:activity", { working: [...pending.values()].filter(one => one.due === null).map(one => one.entry.name) })
    }

    /** The async runs a replay says land now, each settled first; every other settled run stays where it is. */
    async function named(names: readonly string[]): Promise<Array<{ outcome: Outcome; owner: AbortSignal }>> {
        const due: Array<{ outcome: Outcome; owner: AbortSignal }> = []
        for (const name of names) {
            const running = pending.get(name)
            if (running && running.due === null) await running.settled
            const at = ready.findIndex(item => item.outcome.entry.name === name)
            if (at < 0) throw err("COGNET_SCHEDULE_INVALID", { detail: `a replay says ${name}'s run lands at this tick, but ${name} has no run to land — the replay and the mind it replays have diverged` })
            due.push(...ready.splice(at, 1))
        }
        return due
    }

    return {
        /** Whether a run of `name` is still to land. */
        busy(name: string): boolean {
            return pending.has(name)
        },

        /**
         * Start an ASYNC run beside the tick, on a snapshot of what it
         * declared, its writes buffered. `handed` is what it was given to
         * stream, reported as read.
         */
        launch(entry: NamedSystem, run: Run, handed: Read[], end: () => Promise<void>): void {
            const isolation = ecs.isolate({ system: entry.name, reads: access.readable(entry), writes: access.writable(entry) })
            const at = Date.now()
            // Its services end with it — every handle it still holds let go — however it ends.
            const started = Promise.resolve().then(() => isolation.observeAsync(() => isolation.run(() => Promise.resolve(entry.system.run(run)))))
                .then(observed => end().then(() => observed), cause => end().then(() => { throw cause }))
            const ran = (): Ran => ({ at: at, durationMs: Date.now() - at, async: true })
            const settled: Promise<Outcome> = started.then(
                observed => ({ kind: "landed", entry: entry, commit: isolation.commit, reads: [...observed.reads, ...handed], queries: observed.queries, ran: ran() }),
                cause => run.signal.aborted
                    ? { kind: "cancelled", entry: entry, ran: ran() }
                    : { kind: "failed", entry: entry, cause: cause, ran: ran() },
            )
            hold(entry, run.signal, settled, null)
        },

        /** Hold a LAGGED run, started now, to land at the start of tick `due`. */
        defer(entry: NamedSystem, owner: AbortSignal, settled: Promise<Outcome>, due: number): void {
            hold(entry, owner, settled, due)
        },

        /**
         * Land, at the start of tick `tick`: every lagged run due, waiting for
         * any still going; and every async run that has settled — or, in a
         * replay, exactly those it names. Returns how long the tick waited on
         * each run it had to wait for.
         */
        async land(tick: number, replayed: readonly string[] | undefined): Promise<Array<{ system: string; ms: number }>> {
            const due = replayed ? await named(replayed) : ready.splice(0)
            const held: Array<{ system: string; ms: number }> = []
            for (const [name, one] of [...pending]) {
                if (one.due === null || one.due > tick) continue
                if (!one.done) {
                    const waiting = Date.now()
                    await one.settled
                    const ms = Date.now() - waiting
                    held.push({ system: name, ms: ms })
                    void emit("cognet:system:overrun", { tick: ecs.state.stamp().tick, system: name, lag: one.entry.system.lag ?? 0, waitedMs: ms })
                }
                pending.delete(name)
                due.push({ outcome: await one.settled, owner: one.owner })
            }

            const outcomes = due.map(item => item.outcome).sort((a, b) => (a.entry.name < b.entry.name ? -1 : 1))
            let failure: unknown = null
            for (const outcome of outcomes) {
                if (outcome.kind === "cancelled") {
                    void emit("cognet:system:run", { ...ecs.state.stamp(), system: outcome.entry.name, at: outcome.ran.at, durationMs: outcome.ran.durationMs, outcome: "interrupted", async: true })
                    continue
                }
                try {
                    // Reported with the run's own timing: landing takes no time;
                    // the run computed elsewhere, for `ran.durationMs`.
                    await trace.system(outcome.entry.name, async note => {
                        if (outcome.kind === "failed") throw outcome.cause
                        await outcome.commit()
                        note({ reads: outcome.reads, queries: outcome.queries })
                    }, outcome.ran)
                } catch (cause) {
                    failure ??= cause
                }
            }
            if (failure !== null) throw failure
            return held
        },

        /** Whether work `owner` started has yet to land. */
        owes(owner: AbortSignal): boolean {
            return [...pending.values()].some(one => one.owner === owner) || ready.some(item => item.owner === owner)
        },

        /**
         * Resolves when every ASYNC run `owner` started has settled. Never
         * rejects. A wake waits for its async runs — they make engine calls,
         * cancelled through it — and not for its lagged ones, which make
         * none and land by tick count whatever the wake does.
         */
        settled(owner: AbortSignal): Promise<void> {
            return Promise.all([...pending.values()].filter(one => one.owner === owner && one.due === null).map(one => one.settled)).then(() => {})
        },
    }
}

export type LaterT = ReturnType<typeof Later>

type Pending = {
    entry: NamedSystem
    owner: AbortSignal
    settled: Promise<Outcome>
    /** Whether it has settled. */
    done: boolean
    /** The tick a lagged run lands at; null for an async run, which lands when it settles. */
    due: number | null
}
