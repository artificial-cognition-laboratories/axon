import { readlinkSync } from "node:fs"
import { err } from "@arcforge/err"
import type { Component, EcsT, Written } from "../ecs"
import { access, type NamedSystem, type Run } from "../schedule"
import { Mirror, type MirrorT } from "./mirror"
import { wire, type Job, type Reply } from "./wire"

export type ServeOpts = {
    /** Where jobs arrive and replies go — the worker's parentPort. */
    port: { on(event: "message", handler: (job: Job) => void): unknown; postMessage(reply: Reply): void }
    /** The systems this bundle defines. Read at the first job: the bundle has finished evaluating by then. */
    systems(): readonly NamedSystem[]
    /** This thread's world, which the mirror keeps in step with the main thread's. */
    world(): EcsT
}

/**
 * Serve — the worker side: run each job's system against a copy of the world
 * and send back what it wrote.
 *
 * The run goes through the same Isolation an async system gets — declared
 * reads only, writes buffered — so a system behaves identically on either
 * thread, and enforcement happens on every access here exactly as it does
 * there. What it read is observed for the run record.
 *
 * A job that throws replies `failed`; the worker carries on. Only a fault in
 * the protocol itself — a job for a system this bundle does not define —
 * means the two sides disagree about the cognet, and that is still a reply:
 * the main thread decides what a failed run means.
 */
export function Serve(opts: ServeOpts) {
    let mirror: MirrorT | null = null
    /** This thread's OS id, read at the first job — what lets a reader of /proc say which worker a thread is. */
    let tid: number | null | undefined
    let byName: Map<string, NamedSystem> | null = null

    function system(name: string): NamedSystem {
        byName ??= new Map(opts.systems().map(entry => [entry.name, entry]))
        const found = byName.get(name)
        if (!found) throw err("COGNET_WORKER_FAILED", { detail: `this worker's bundle defines no system "${name}" — the main thread and the worker loaded different cognets` })
        return found
    }

    function run(job: Job): Reply {
        const entry = system(job.system)
        const world = opts.world()
        mirror ??= Mirror({ state: world.state })
        mirror.sync(job)

        const isolation = world.isolate({ system: entry.name, reads: access.readable(entry), writes: access.writable(entry) })
        const at = Date.now()
        const observed = isolation.observe(() => entry.system.run(onWorker(entry, job)))
        const durationMs = Date.now() - at
        if (observed.result !== undefined) {
            throw err("COGNET_SCHEDULE_INVALID", { detail: `${entry.name} returned a value — a worker run returns nothing` })
        }
        const changes = isolation.changes()
        mirror.keep(changes, Date.now())
        return { kind: "done", id: job.id, tid: tid ?? null, changes: wire.out(changes), reads: observed.reads, queries: observed.queries, at: at, durationMs: durationMs }
    }

    return {
        /** Start answering jobs. */
        listen(): void {
            opts.port.on("message", job => {
                if (tid === undefined) tid = thread()
                let reply: Reply
                try {
                    reply = run(job)
                } catch (cause) {
                    reply = { kind: "failed", id: job.id, tid: tid ?? null, fault: wire.fault(cause) }
                }
                opts.port.postMessage(reply)
            })
        },
    }
}

export type ServeT = ReturnType<typeof Serve>

/** This thread's OS id from /proc/thread-self (`<pid>/task/<tid>`), or null where there is no /proc. */
function thread(): number | null {
    try {
        return Number(readlinkSync("/proc/thread-self").split("/").pop())
    } catch {
        // Not Linux: there is no per-thread accounting to match it against either.
        return null
    }
}

/**
 * The run a worker system receives. `now` and what it streams cross; the
 * wake's signal and stimuli live on the main thread, and reaching for them
 * says so.
 */
function onWorker(entry: NamedSystem, job: Job): Run {
    const refuse = (what: string): never => {
        throw err("COGNET_WORKER_FAILED", { detail: `${entry.name} read ${what} on a worker thread — it lives on the main thread` })
    }
    // Every stream it declared, empty where nothing was written since it last ran.
    const streams = new Map<string, Written<any>[]>((entry.system.streams ?? []).map(component => [component.name, []]))
    for (const [component, entity, value, at, rev] of job.streams) {
        const list = streams.get(component)
        if (!list) throw err("COGNET_WORKER_FAILED", { detail: `${entry.name} was sent "${component}" to stream, which it does not declare — the main thread and the worker loaded different cognets` })
        list.push({ entity: entity, value: value, at: at, rev: rev })
    }
    return {
        now: job.now,
        get stimuli(): never { return refuse("stimuli") },
        get signal(): never { return refuse("the wake's signal") },
        get services(): never { return refuse("services") },
        since: <T>(handle: Component<T>): readonly Written<T>[] => {
            const found = streams.get(handle.name)
            if (!found) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${entry.name} asked for every write to "${handle.name}" without declaring it in streams` })
            return found
        },
    }
}
