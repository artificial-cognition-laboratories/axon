import { availableParallelism } from "node:os"
import { err } from "@arcforge/err"
import type { EcsEmit, EcsT, StateT } from "../ecs"
import { access, type NamedSystem, type ScheduleThreads, type Streamed, type ThreadResult } from "../schedule"
import { Known, type KnownT } from "./known"
import { Pool, type PoolT } from "./pool"
import { wire, type Job } from "./wire"

export type ThreadsOpts = {
    /** The world jobs read from and land in. */
    ecs: EcsT
    /** The module each worker loads — the cognet's bundle. */
    url: URL
    /** The cognet's `threads` setting, as written. */
    threads: "auto" | number | undefined
    /** Where each worker says which OS thread it is — `cognet:thread:start`, once per worker. */
    emit: EcsEmit
}

/** At most this many workers under "auto": past it, the copies cost more than the cores buy. */
const MOST = 4

/**
 * Threads — runs `thread: "worker"` systems on worker threads.
 *
 * Owns the dispatch: which worker takes a job, what that worker must be sent
 * to hold the world the system reads (see Known), and turning its reply into
 * a result the schedule lands. The schedule decides WHEN a system may run;
 * this decides WHERE.
 *
 * A job goes to the worker that last ran its system when that one is free —
 * it already holds that system's recalled state, so nothing large crosses —
 * and otherwise to any free worker, which is sent what it lacks. Jobs wait in
 * arrival order when every worker is busy.
 *
 * A worker is free once it replies, whether or not its result has landed: a
 * lagged result waits ticks to, and holding the worker that long left half
 * the pool idle behind two lagged systems (measured 2026-10-09). What it
 * wrote is pending until then — see Known for what a job sent meanwhile is
 * told.
 */
export function Threads(opts: ThreadsOpts) {
    /** Built on first use: reading the setting is work, and a cognet whose worker systems never run does none. */
    let built: Workers | null = null
    /** The worker each system last ran on. */
    const last = new Map<string, number>()
    /** Workers that have announced which thread they are. */
    const started = new Set<number>()
    const queue: Waiting[] = []
    let ids = 0

    function workers(): Workers {
        if (built) return built
        const size = count(opts.threads)
        built = {
            size: size,
            pool: Pool({ url: opts.url, size: size }),
            known: Array.from({ length: size }, () => Known()),
            owed: Array.from({ length: size }, () => []),
            busy: Array.from({ length: size }, () => false),
        }
        return built
    }

    function pump(): void {
        const { busy } = workers()
        while (queue.length > 0) {
            const free = busy.findIndex(taken => !taken)
            if (free < 0) return
            const job = queue.shift()!
            const warm = last.get(job.entry.name)
            send(warm !== undefined && !busy[warm] ? warm : free, job)
        }
    }

    function release(index: number): void {
        workers().busy[index] = false
        pump()
    }

    function send(index: number, waiting: Waiting): void {
        const { entry } = waiting
        const { pool, known, owed, busy } = workers()
        busy[index] = true
        last.set(entry.name, index)
        // The world it reads: as it stood when the run started, when the schedule took it then; else as it is.
        const world = waiting.from ?? opts.ecs.state
        const job: Job = {
            kind: "job",
            id: ++ids,
            system: entry.name,
            now: waiting.now,
            entities: [...world.entities],
            ...known[index]!.delta(world, access.readable(entry)),
            streams: [...waiting.streams].flatMap(([component, written]) => written.map((one): Job["streams"][number] => [component, one.entity, one.value, one.at, one.rev])),
            confirmed: owed[index]!.splice(0),
        }

        pool.send(index, job).then(reply => {
            if (!started.has(index)) {
                started.add(index)
                void opts.emit("cognet:thread:start", { index: index, pid: process.pid, tid: reply.tid })
            }
            if (reply.kind === "failed") {
                release(index)
                waiting.reject(wire.revive(reply.fault))
                return
            }
            known[index]!.forget(reply.changes)
            release(index)
            let changes
            try {
                changes = wire.in(reply.changes, entry.system.writes ?? [], entry.name)
            } catch (cause) {
                known[index]!.discard(reply.changes)
                waiting.reject(cause)
                return
            }
            let settled = false
            const settle = () => {
                if (settled) throw err("COGNET_WORKER_FAILED", { detail: `${entry.name}: a result was committed or discarded twice` })
                settled = true
            }
            waiting.resolve({
                reads: reply.reads,
                queries: reply.queries,
                ran: { at: reply.at, durationMs: reply.durationMs, thread: index },
                commit() {
                    settle()
                    opts.ecs.apply({ system: entry.name, writes: access.writable(entry) }, changes)
                    owed[index]!.push(...known[index]!.confirm(opts.ecs.state, reply.changes))
                },
                discard() {
                    settle()
                    known[index]!.discard(reply.changes)
                },
            })
        }, cause => {
            // The pool broke: the worker is gone, and so is what it held.
            waiting.reject(cause)
        })
    }

    const threads: ScheduleThreads & { close(): Promise<void> } = {
        get size(): number {
            return workers().size
        },

        run(entry: NamedSystem, given: { now: number; streams: Streamed; from?: StateT }): Promise<ThreadResult> {
            if (workers().size === 0) return Promise.reject(err("COGNET_WORKER_FAILED", { detail: `${entry.name}: threads is 0 — worker systems run on the main thread` }))
            return new Promise((resolve, reject) => {
                queue.push({ entry: entry, now: given.now, streams: given.streams, ...(given.from ? { from: given.from } : {}), resolve: resolve, reject: reject })
                pump()
            })
        },

        /** Stop every worker. Called when the cognet unloads. */
        close(): Promise<void> {
            const closed = err("COGNET_WORKER_FAILED", { detail: "the cognet unloaded with worker systems waiting" })
            for (const waiting of queue.splice(0)) waiting.reject(closed)
            return built ? built.pool.close() : Promise.resolve()
        },
    }
    return threads
}

export type ThreadsT = ReturnType<typeof Threads>

type Workers = {
    size: number
    pool: PoolT
    known: KnownT[]
    /** Confirmations owed to each worker, sent with its next job. */
    owed: Array<Job["confirmed"]>
    busy: boolean[]
}

type Waiting = {
    entry: NamedSystem
    now: number
    /** What it streams, as it was handed when it was admitted. */
    streams: Streamed
    /** The world as it stood when it started, when that was taken then (a lagged run). */
    from?: StateT
    resolve(result: ThreadResult): void
    reject(cause: unknown): void
}

/**
 * How many workers a setting means. "auto": two fewer than the cores — the
 * main thread and the rest of the machine keep those — at most MOST, at
 * least one. A number is taken as written, and must be a whole one.
 */
function count(setting: "auto" | number | undefined): number {
    if (setting === undefined || setting === "auto") return Math.max(1, Math.min(MOST, availableParallelism() - 2))
    if (!Number.isInteger(setting) || setting < 0) throw err("COGNET_SCHEDULE_INVALID", { detail: `threads: ${setting} — a whole number of threads, 0 for none, or "auto"` })
    return setting
}
