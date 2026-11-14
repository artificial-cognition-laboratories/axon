import { err } from "@arcforge/err"
import { effects } from "../effects"
import type { AxonStimulusEntry, CognetTickComplete } from "@arcforge/types"
import type { Ran } from "../clock"
import { definitions, type EcsEmit, type EcsT, type Read } from "../ecs"
import { access, type Streamed } from "./access"
import { Cursors } from "./cursors"
import { Inbox } from "./inbox"
import { Later, type Outcome } from "./later"
import { Lineage } from "./lineage"
import { stimuli } from "./input"
import { systems as registry } from "./system"
import type { NamedSystem, Run, ScheduleServices, ScheduleThreads, ScheduleTrace, ThreadResult, Tick } from "./types"

export type ScheduleOpts = {
    /** The world the systems run in. Each run is observed through it. */
    ecs: EcsT
    systems: readonly NamedSystem[]
    /** Where the schedule declares itself. The cognet's own `kernel.emit`. */
    emit: EcsEmit
    trace: ScheduleTrace
    /** The mind's clock, for a continuous mind — declared to readers; the schedule paces nothing by it. */
    hz?: number
    /** Where `thread: "worker"` systems run. Absent: on the main thread, in order. */
    threads?: ScheduleThreads
    /** Each run's services. Absent: a mind with no uses, whose runs reach none. */
    services?: ScheduleServices
    /** The uses cognet.config.ts declares — what a system's `uses` is checked against. */
    uses?: readonly string[]
}

/**
 * Schedule — every system, in the order its data demands, when what runs it
 * has changed.
 *
 * ORDER IS DERIVED, never declared. A system that reads a component runs after
 * every system that writes it; `recalls` read last tick's value and add no
 * edge. Nothing about the order is authored, so it cannot drift from what the
 * systems actually depend on.
 *
 * A SYSTEM RUNS WHEN WHAT RUNS IT HAS CHANGED, at most once a tick: what it
 * reads — or, when it names them, its `on` — changed since it last ran, by
 * any system but itself; a stimulus or a streamed write waits for it; or it
 * is run by `clock`, which changes every tick. Nothing changed: it does not
 * run, and costs the tick one comparison. The schedule has no rates and no
 * opinion on pace: a mind that wants something done ten times a second
 * changes what runs it ten times a second.
 *
 * INPUT IS BUFFERED between ticks. A system that declares `reads: [stimuli]`
 * receives everything that arrived since IT last ran, through its own cursor;
 * one that `streams` a component receives every value written to it since it
 * last ran, through another (see Cursors).
 *
 * ONE TICK'S WORK IS ONE TICK'S. A tick is a dataflow over the order: a
 * system starts once every earlier system it conflicts with — one writes what
 * the other reads or recalls — has finished. A `thread: "worker"` system runs
 * on a worker meanwhile, and the main thread carries on with whatever else is
 * ready. Its result lands inside its own trace bracket before anything that
 * reads it starts, so the tick computes exactly what running in order would;
 * only where the time went differs. Main-thread runs never overlap each other
 * — they share one thread — and brackets never interleave.
 *
 * LONGER WORK GOES OVER, BY DECLARATION. A system with `lag: n` starts on a
 * snapshot, the tick carries on without it, and its writes land at the start
 * of the tick n later — counted, so replays see what live saw. An `async`
 * system runs beside the tick and lands when it is done. Both land before any
 * system runs, and neither is started again until it has (see Later).
 *
 * TICKS COALESCE. Continuous wakes overlap by design, so at most one tick runs
 * and at most one waits; every wake that arrives mid-tick merges into the
 * waiting one. Nothing is lost — its stimuli are already buffered — and the
 * backlog can never exceed one tick.
 *
 * THE SCHEDULE OWNS THE TICK. It opens each one — the number every write in
 * it is stamped with — and records what it answered: how many wakes, and
 * which stimuli it admitted, by their place in its stream; and, when it
 * closes, what it waited on.
 * That is enough to run a session again tick for tick as it ran, merges and
 * all. A tick counted per WAKE, as it was, numbered twelve ticks where one
 * ran, and stamped a tick's writes with whichever wake was newest.
 *
 * On the first run the schedule checks its lineage and DECLARES itself. Every
 * run is ENFORCED: a system that touches something it did not declare fails.
 */
export function Schedule(opts: ScheduleOpts) {
    const { ecs, emit, trace } = opts
    const lineage = Lineage({ systems: opts.systems, hz: opts.hz, ...(opts.uses ? { uses: opts.uses } : {}) })
    // Readers subscribe at construction — wiring, not work — so the very
    // first batch, which arrives before the first tick, is already buffered
    // for them.
    const input = Inbox({ readers: opts.systems.filter(entry => access.reads(entry, stimuli)).map(entry => entry.name) })
    const cursors = Cursors({ ecs: ecs, systems: opts.systems })
    const later = Later({ ecs: ecs, emit: emit, trace: trace })
    /** What each system took from the inbox and has not yet finished with — its run, or what that run started, still going. */
    const holding = new Map<string, readonly AxonStimulusEntry[]>()
    /** Systems that have run at least once. */
    const done = new Set<string>()
    /** `once` systems that have had their run: they stream nothing more. */
    const spent = new Set<string>()
    /** The world's rev when each system last ran — what "changed since" is measured from. */
    const seen = new Map<string, number>()
    /** The order, and what each system waits for in it. Built on the first tick. */
    let plan: { order: NamedSystem[]; waits: Map<string, string[]> } | null = null
    /** Ticks this schedule has run — what a lag counts. Its own, so it never depends on who numbers them. */
    let ticked = 0

    /** The tick in progress, and the one tick allowed to wait behind it. */
    let running: Promise<void> | null = null
    let waiting: Promise<void> | null = null
    /** The latest wake to merge into the waiting tick — it runs with that wake's clock and signal. */
    let latest: Tick | null = null
    /** Wakes since a tick last opened: what the next one answers. */
    let wakes = 0

    function prepare(): { order: NamedSystem[]; waits: Map<string, string[]> } {
        lineage.check()
        for (const frame of definitions.frames()) ecs.schema.frame(frame)
        for (const component of lineage.components()) ecs.schema.declare(component)
        cursors.keep()
        // With the process it runs in: per-thread CPU is accounted by OS id,
        // and the brain's main thread is the one whose id is this pid.
        void emit("cognet:schedule:declare", { ...lineage.declaration(), pid: process.pid })
        return { order: lineage.order(), waits: lineage.waits() }
    }

    /** Where a run executes: inside the tick on this thread or a worker, beside it, or over it. */
    function where(entry: NamedSystem): "main" | "worker" | "beside" | "over" {
        if (registry.async(entry.system)) return "beside"
        if ((entry.system.lag ?? 0) > 0) return "over"
        if (onWorker(entry)) return "worker"
        return "main"
    }

    /** Whether a system's work goes to a worker: it asks to, and there are workers. */
    function onWorker(entry: NamedSystem): boolean {
        return entry.system.thread === "worker" && opts.threads !== undefined && opts.threads.size > 0
    }

    /**
     * Whether a ready system runs this tick, and with what. Null: it is
     * busy, done, or nothing that runs it changed. Checked when the system
     * becomes READY, not when the tick starts — the systems before it may
     * just have changed what runs it.
     */
    function admit(entry: NamedSystem, at: Tick): Admitted | null {
        // Backpressure: a system with a run still to land is not marked as
        // having seen what changed, so it runs once that run has landed.
        if (later.busy(entry.name)) return null
        if (entry.system.once && done.has(entry.name)) return null
        if (!changed(entry)) return null
        done.add(entry.name)
        if (entry.system.once) spent.add(entry.name)
        seen.set(entry.name, ecs.state.rev())
        const taken = cursors.take(entry)
        const reached = opts.services ? opts.services(entry, registry.async(entry.system)) : NONE
        const heard = access.reads(entry, stimuli) ? input.take(entry.name) : null
        if (heard && heard.length > 0) holding.set(entry.name, heard)
        const run = access.run(entry.name, { now: at.now, signal: at.signal, stimuli: heard, streams: taken.streams, services: reached.services })
        return { run: run, handed: taken.handed, end: reached.end }
    }

    /** A sync run on this thread, inside its trace bracket, observed and enforced. */
    async function execute(entry: NamedSystem, admitted: Admitted): Promise<void> {
        const { run } = admitted
        await trace.system(entry.name, async note => {
            const { result: observed, effects: held } = effects.hold(() => ecs.observe(() => entry.system.run(run)))
            await admitted.end()
            if (observed.result !== undefined) throw returned(entry)
            access.enforce(entry, observed)
            await effects.make(held)
            note({
                reads: [...observed.reads, ...admitted.handed],
                queries: observed.queries,
                // The stimuli are causes too — without them every chain
                // of "why" stops at ingestion, saying it read nothing.
                ...(access.reads(entry, stimuli) ? { inputs: access.inputs(run.stimuli) } : {}),
            })
        })
    }

    /** A worker run, back on this thread: its writes applied inside its own bracket, with its own timing. */
    async function arrive(arrival: Arrival): Promise<void> {
        if (arrival.kind === "failed") {
            await trace.system(arrival.entry.name, async () => { throw arrival.cause }, arrival.ran)
            return
        }
        const { result } = arrival
        await trace.system(arrival.entry.name, async note => {
            result.commit()
            note({ reads: [...result.reads, ...arrival.handed], queries: result.queries })
        }, result.ran)
    }

    /**
     * Start a LAGGED run: on a worker when there is one, else here and now —
     * either way on a snapshot taken now, its writes held to land `lag` ticks
     * from this one.
     */
    function lag(entry: NamedSystem, admitted: Admitted): void {
        const steps = entry.system.lag!
        const isolation = ecs.isolate({ system: entry.name, reads: access.readable(entry), writes: access.writable(entry) })
        const at = Date.now()
        let settled: Promise<Outcome>
        if (onWorker(entry)) {
            settled = opts.threads!.run(entry, { now: admitted.run.now, streams: streamsOf(entry, admitted.run), from: isolation.world }).then(
                (result): Outcome => ({ kind: "landed", entry: entry, commit: result.commit, reads: [...result.reads, ...admitted.handed], queries: result.queries, ran: { ...result.ran, lag: steps } }),
                (cause): Outcome => ({ kind: "failed", entry: entry, cause: cause, ran: { at: at, durationMs: Date.now() - at, lag: steps } }),
            )
        } else {
            settled = Promise.resolve(here(entry, admitted, isolation, at, steps))
        }
        later.defer(entry, admitted.run.signal, settled, ticked + steps)
    }

    /**
     * One tick's systems, overlapped where the data allows (see the header).
     * Returns how long it waited on each worker it had to wait for.
     *
     * The main thread loops: land whatever has come back from a worker,
     * start every ready system that does not need this thread, run one that
     * does, and when nothing is ready, wait for a worker. A failure stops
     * every start; runs already on a worker finish, are discarded — they
     * belong to a tick that did not complete — and are reported interrupted.
     */
    async function flow(at: Tick, order: readonly NamedSystem[], waits: Map<string, string[]>): Promise<Map<string, number>> {
        const left = new Set(order.map(entry => entry.name))
        const finished = new Set<string>()
        const mains: Array<{ entry: NamedSystem; admitted: Admitted }> = []
        const away = new Set<string>()
        const arrived: Arrival[] = []
        const held = new Map<string, number>()
        let notify: (() => void) | null = null
        let failure: unknown = null

        const ready = (entry: NamedSystem) => left.has(entry.name) && waits.get(entry.name)!.every(name => finished.has(name))
        const position = new Map(order.map((entry, index) => [entry.name, index]))

        function offload(entry: NamedSystem, admitted: Admitted): void {
            away.add(entry.name)
            const sent = Date.now()
            void opts.threads!.run(entry, { now: admitted.run.now, streams: streamsOf(entry, admitted.run) }).then(
                (result): Arrival => ({ kind: "landed", entry: entry, result: result, handed: admitted.handed }),
                (cause): Arrival => ({ kind: "failed", entry: entry, cause: cause, ran: { at: sent, durationMs: Date.now() - sent } }),
            ).then(arrival => {
                arrived.push(arrival)
                notify?.()
                notify = null
            })
        }

        /** Start everything ready that does not hold this thread; queue what does. Repeats while a skip frees more. */
        function dispatch(): void {
            let moved = true
            while (moved) {
                moved = false
                for (const entry of order) {
                    if (!ready(entry)) continue
                    left.delete(entry.name)
                    const admitted = admit(entry, at)
                    if (!admitted) {
                        finished.add(entry.name)
                        moved = true
                        continue
                    }
                    const place = where(entry)
                    if (place === "beside" || place === "over") {
                        // Its writes land in a later tick; what waits for it here waits only for it to start.
                        if (place === "beside") later.launch(entry, admitted.run, admitted.handed, admitted.end)
                        else lag(entry, admitted)
                        finished.add(entry.name)
                        moved = true
                    } else if (place === "worker") offload(entry, admitted)
                    else mains.push({ entry: entry, admitted: admitted })
                }
            }
            mains.sort((a, b) => position.get(a.entry.name)! - position.get(b.entry.name)!)
        }

        while (failure === null) {
            while (arrived.length > 0 && failure === null) {
                const arrival = arrived.shift()!
                away.delete(arrival.entry.name)
                try {
                    await arrive(arrival)
                    finished.add(arrival.entry.name)
                } catch (cause) {
                    failure = cause
                }
            }
            if (failure !== null) break
            try {
                dispatch()
            } catch (cause) {
                failure = cause
                break
            }
            const next = mains.shift()
            if (next) {
                try {
                    await execute(next.entry, next.admitted)
                    finished.add(next.entry.name)
                } catch (cause) {
                    failure = cause
                }
                continue
            }
            if (away.size === 0) break
            // Nothing here can run until a worker answers: the tick is held by
            // whichever answers first.
            const idle = Date.now()
            await new Promise<void>(resolve => { notify = resolve })
            const by = arrived[0]!.entry.name
            held.set(by, (held.get(by) ?? 0) + Date.now() - idle)
        }

        if (failure === null) {
            if (left.size > 0) throw err("COGNET_SCHEDULE_INVALID", { detail: `the tick ended with ${[...left].join(", ")} never ready — the schedule's waits are inconsistent` })
            return held
        }

        // Drain what is still on a worker: it cannot land in a failed tick.
        while (away.size > 0 || arrived.length > 0) {
            if (arrived.length === 0) await new Promise<void>(resolve => { notify = resolve })
            const arrival = arrived.shift()!
            away.delete(arrival.entry.name)
            if (arrival.kind === "landed") {
                arrival.result.discard()
                void emit("cognet:system:run", { ...ecs.state.stamp(), system: arrival.entry.name, at: arrival.result.ran.at, durationMs: arrival.result.ran.durationMs, outcome: "interrupted", ...(arrival.result.ran.thread !== undefined ? { thread: arrival.result.ran.thread } : {}) })
            } else {
                // Its own failure is recorded in its bracket; the tick fails with the first.
                await trace.system(arrival.entry.name, async () => { throw arrival.cause }, arrival.ran).catch(() => {})
            }
        }
        throw failure
    }

    /**
     * Whether what runs a system has changed since it last ran — or it never
     * has (see access.triggers). Its OWN writes do not count: a system that
     * reads what it writes would otherwise run itself forever, and a wake
     * waiting for quiet would never get it.
     */
    function changed(entry: NamedSystem): boolean {
        const since = seen.get(entry.name)
        if (since === undefined) return true
        const runs = access.triggers(entry)
        if (runs.clock) return true
        if (runs.stimuli && input.waiting(entry.name)) return true
        if (runs.streams.size > 0 && cursors.waiting(entry)) return true
        const own = access.writable(entry)
        for (const name of runs.components) {
            if (!own.has(name) && ecs.state.changedSince(name, since)) return true
        }
        return false
    }

    async function tick(at: Tick, note: (fields: Omit<CognetTickComplete, "tick">) => void): Promise<void> {
        plan ??= prepare()
        ticked += 1
        const overran = await later.land(ticked, at.lands)
        const waited = await flow(at, plan.order, plan.waits)
        cursors.trim(spent)
        input.trim()
        release()
        const held = [...overran, ...[...waited].map(([system, ms]) => ({ system: system, ms: ms }))].filter(one => one.ms > 0)
        if (held.length > 0) note({ held: held })
    }

    /**
     * Let go of the stimuli each system took, once nothing it started is still
     * running — a sync run ends inside its tick, an async or lagged one when it
     * lands — and say which are now settled. A system has at most one run in
     * flight, so what it holds is what that run took.
     */
    function release(): void {
        const settled: AxonStimulusEntry[] = []
        for (const [system, held] of holding) {
            if (later.busy(system)) continue
            holding.delete(system)
            settled.push(...input.release(held))
        }
        announce(settled)
    }

    /** Say which stimuli the mind is done with. */
    function announce(settled: readonly AxonStimulusEntry[]): void {
        if (settled.length > 0) void emit("cognet:settled", { seqs: settled.map(entry => entry.time.seq) })
    }

    /** Open the next tick: it admits what has arrived, and answers every wake since the last one opened. */
    function start(at: Tick): Promise<void> {
        const admitted = input.admit()
        const answered = wakes
        wakes = 0
        const opened = { now: at.now, wakes: answered, ...(admitted ? { admitted: admitted } : {}) }
        const current = trace.tick(note => tick(at, note), opened).finally(() => {
            if (running === current) running = null
        })
        running = current
        return current
    }

    return {
        lineage: lineage,

        /**
         * Run one tick, or merge into the one already waiting. Resolves when
         * the tick that carried this call's stimuli completes, and rejects if
         * that tick fails.
         */
        run(at: Tick): Promise<void> {
            announce(input.receive(at.stimuli))
            latest = at
            wakes += 1
            if (!running) return start(at)
            if (waiting) return waiting

            // Registered HERE, in the merging wake's async context, so the
            // waiting tick's spans belong to a wake that is still open — not
            // to the one whose tick just finished. The previous tick's own
            // failure is not swallowed: it rejects that tick's callers.
            waiting = running.catch(() => {}).then(() => {
                waiting = null
                return start(latest!)
            })
            return waiting
        },

        /** Whether work `owner` started has yet to land — async or lagged. */
        busy(owner: AbortSignal): boolean {
            return later.owes(owner)
        },

        /**
         * Resolves when every async run `owner` started has settled. Never
         * rejects. A wake waits for ITS runs — it holds open so they can be
         * cancelled through it — and not for other wakes' runs: waiting for
         * those made every wake live as long as the slowest model call, and a
         * continuous mind starts twenty a second.
         */
        settled(owner: AbortSignal): Promise<void> {
            return later.settled(owner)
        },
    }
}

export type ScheduleT = ReturnType<typeof Schedule>

/** A run admitted to a tick: what it is handed, and what of that it streamed — reported as read. */
type Admitted = { run: Run; handed: Read[]; end(): Promise<void> }

/** A run in a mind that uses nothing: any service it reaches for is refused by name. */
const NONE = {
    services: new Proxy({}, {
        get(_target, name) {
            throw err("COGNET_UNDECLARED_ACCESS", { detail: `services.${String(name)}: this mind declares no uses in cognet.config.ts` })
        },
    }),
    end: () => Promise.resolve(),
}

/** A worker run back on the main thread: its result, or why there is none. */
type Arrival =
    | { kind: "landed"; entry: NamedSystem; result: ThreadResult; handed: Read[] }
    | { kind: "failed"; entry: NamedSystem; cause: unknown; ran: Ran }

/** What a run streams, by name, as it crosses to a worker: everything it was handed. */
function streamsOf(entry: NamedSystem, run: Run): Streamed {
    return new Map((entry.system.streams ?? []).map(component => [component.name, run.since(component)]))
}

/** A lagged run done here and now, in its isolation: what it wrote, held — or why it failed, held to fail the tick it lands in. */
function here(entry: NamedSystem, admitted: Admitted, isolation: ReturnType<EcsT["isolate"]>, at: number, lag: number): Outcome {
    try {
        const { result: observed, effects: held } = effects.hold(() => isolation.observe(() => entry.system.run(admitted.run)))
        if (observed.result !== undefined) throw returned(entry)
        const commit = async (): Promise<void> => {
            isolation.commit()
            await effects.make(held)
        }
        return { kind: "landed", entry: entry, commit: commit, reads: [...observed.reads, ...admitted.handed], queries: observed.queries, ran: { at: at, durationMs: Date.now() - at, lag: lag } }
    } catch (cause) {
        return { kind: "failed", entry: entry, cause: cause, ran: { at: at, durationMs: Date.now() - at, lag: lag } }
    }
}

/** A sync run that returned something: it was written as if it could be awaited. */
function returned(entry: NamedSystem): Error {
    return err("COGNET_SCHEDULE_INVALID", { detail: `${entry.name} returned a value — a sync run returns nothing; make it \`async run()\` to run beside the tick` })
}
