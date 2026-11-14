import { Worker } from "node:worker_threads"
import { err, type AxonError } from "@arcforge/err"
import { MARK, type Job, type Reply } from "./wire"

export type PoolOpts = {
    /** The module each worker loads: the cognet's own bundle, which serves jobs when it finds MARK. */
    url: URL
    size: number
}

/**
 * Pool — the worker threads, and nothing about what runs on them.
 *
 * Workers start on the first job, not at construction: a cognet whose worker
 * systems never run never pays for threads. Each worker handles one job at a
 * time; `send` resolves with its reply.
 *
 * A worker that fails to start, throws outside a job, or exits on its own
 * BREAKS the pool. Every job waiting on any worker rejects, and so does every
 * later send — a tick that cannot get a system's result fails, rather than
 * running on with a hole where that system was.
 */
export function Pool(opts: PoolOpts) {
    let workers: Worker[] | null = null
    /** The reply each worker owes, by worker. */
    const owed = new Map<number, { id: number; resolve(reply: Reply): void; reject(cause: AxonError): void }>()
    let broken: AxonError | null = null
    let closing = false

    function fail(index: number, why: string): void {
        if (closing) return
        broken ??= err("COGNET_WORKER_FAILED", { detail: `worker ${index}: ${why}` })
        for (const pending of owed.values()) pending.reject(broken)
        owed.clear()
    }

    function spawn(): Worker[] {
        return Array.from({ length: opts.size }, (_, index) => {
            const worker = new Worker(opts.url, { workerData: { [MARK]: true } })
            worker.on("message", (reply: Reply) => {
                const pending = owed.get(index)
                if (!pending || pending.id !== reply.id) return fail(index, `replied to job ${reply.id}, which it was not running`)
                owed.delete(index)
                pending.resolve(reply)
            })
            worker.on("error", cause => fail(index, cause instanceof Error ? cause.message : String(cause)))
            worker.on("exit", code => fail(index, `exited with code ${code}`))
            return worker
        })
    }

    return {
        size: opts.size,

        /** Run a job on one worker. That worker must not already be running one. */
        send(index: number, job: Job): Promise<Reply> {
            if (broken) return Promise.reject(broken)
            if (closing) return Promise.reject(err("COGNET_WORKER_FAILED", { detail: `${job.system}: the pool is closed` }))
            if (owed.has(index)) return Promise.reject(err("COGNET_WORKER_FAILED", { detail: `worker ${index} is already running a job` }))
            workers ??= spawn()
            return new Promise<Reply>((resolve, reject) => {
                owed.set(index, { id: job.id, resolve: resolve, reject: reject })
                workers![index]!.postMessage(job)
            })
        },

        /** Stop every worker. A job still running rejects. */
        async close(): Promise<void> {
            closing = true
            const ending = err("COGNET_WORKER_FAILED", { detail: "the pool closed while a job was running" })
            for (const pending of owed.values()) pending.reject(ending)
            owed.clear()
            if (workers) await Promise.all(workers.map(worker => worker.terminate()))
            workers = null
        },
    }
}

export type PoolT = ReturnType<typeof Pool>
