import type { Worker } from "node:worker_threads"
import { err, type AxonError } from "@arcforge/err"
import { fault, type Ask, type Response } from "./protocol"

/**
 * Calls — requests to one worker, matched to their responses by id.
 *
 * A worker that errors or exits BREAKS the link: every request waiting on it
 * rejects, and so does every later one. A call that cannot be answered fails,
 * rather than waiting on a thread that is gone.
 */
export function Calls(worker: Worker) {
    let next = 1
    const owed = new Map<number, { resolve(value: unknown): void; reject(cause: AxonError): void }>()
    let broken: AxonError | null = null

    function fail(why: string): void {
        broken ??= err("MODEL_RUN_FAILED", { detail: `the vision worker ${why}` })
        for (const pending of owed.values()) pending.reject(broken)
        owed.clear()
    }

    worker.on("message", (response: Response) => {
        const pending = owed.get(response.id)
        if (!pending) return fail(`answered request ${response.id}, which nothing was waiting on`)
        owed.delete(response.id)
        if (response.ok) pending.resolve(response.value)
        else pending.reject(fault.revive(response.fault))
    })
    worker.on("error", cause => fail(`failed: ${cause instanceof Error ? cause.message : String(cause)}`))
    worker.on("exit", code => fail(`exited with code ${code}`))

    return {
        /** The worker is gone: nothing sent to it will be answered. */
        get broken(): boolean {
            return broken !== null
        },

        /** Ask the worker, and resolve with its answer. */
        send(ask: Ask): Promise<unknown> {
            if (broken) return Promise.reject(broken)
            const id = next++
            return new Promise((resolve, reject) => {
                owed.set(id, { resolve: resolve, reject: reject })
                worker.postMessage({ ...ask, id: id })
            })
        },
    }
}

export type CallsT = ReturnType<typeof Calls>
