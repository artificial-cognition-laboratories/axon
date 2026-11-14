import { Worker } from "node:worker_threads"
import { workerPath } from "@arcforge/platform"
import { Calls, type CallsT } from "./calls"
import type { TaskName } from "./protocol"
import type { Device, VisionTask } from "./types"

export type OffloadOpts = {
    /** The transformers library's entry point, as a path the worker imports itself. */
    library: string
}

/**
 * Offload — loads vision weights on a thread of their own and hands back the tasks.
 *
 * A model's forward pass is native work on the thread that calls it, and a
 * dense encoder takes ~200ms a call. Run in the daemon's own process it held
 * the event loop for that long, ~3 times a second: everything else the
 * process serves — an agent's event stream, the dictation meter — arrived in
 * clumps behind it. The weights live in a worker; the caller awaits.
 *
 * ONE worker serves every weight, one request at a time. Two worker threads
 * each running onnxruntime's native addon crash Bun (a segmentation fault —
 * concurrent loads every time, concurrent calls most times, and terminating
 * a worker once). One thread running one request at a time is how the
 * library already ran on the main thread, minus the stall. The worker starts
 * at the first load, stays for the life of the process, and is replaced
 * only if it dies — its weights go with it, and calls to them fail.
 */
export function Offload(opts: OffloadOpts) {
    let current: CallsT | null = null

    /** The link to the live worker, starting one when there is none or the last one died. */
    function link(): CallsT {
        if (current && !current.broken) return current
        // `vision-worker.js` beside the bundle in a published install, the source file in the workspace.
        const worker = new Worker(workerPath(import.meta.dir, "vision-worker.js", "worker.ts"))
        // The daemon is the only reason it exists: it must not hold the process open.
        worker.unref()
        current = Calls(worker)
        return current
    }

    return {
        /** Load `path` in the worker. Rejects with the load's own error. */
        async load(task: TaskName, path: string, device: Device): Promise<VisionTask> {
            const calls = link()
            const handle = await calls.send({ op: "load", library: opts.library, task: task, path: path, device: device }) as number
            return {
                call: input => calls.send({ op: "call", handle: handle, input: input }),
                dispose: async () => { await calls.send({ op: "dispose", handle: handle }) },
            }
        },
    }
}

export type OffloadT = ReturnType<typeof Offload>
