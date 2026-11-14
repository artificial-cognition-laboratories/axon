import { parentPort } from "node:worker_threads"
import { pathToFileURL } from "node:url"
import { err } from "@arcforge/err"
import { Depth } from "./depth"
import { Features } from "./features"
import { Segmenter } from "./masks"
import { fault, type Request, type Response, type TaskName } from "./protocol"
import type { VisionLibrary, VisionTask } from "./types"

/**
 * The vision worker — holds every vision weight the daemon has loaded and
 * answers calls against them, ONE REQUEST AT A TIME.
 *
 * Serial on purpose: the native runtime under the library is not safe to run
 * from two threads at once in this runtime (see Offload), and the requests
 * are queued here rather than interleaved at their awaits, so a load never
 * overlaps a call either.
 *
 * Loads the library itself: a library instance belongs to the thread that
 * imported it, so the daemon's copy cannot be handed across. Local files
 * only, as the daemon's own load is — every file here was downloaded and
 * verified, and a missing one must fail rather than fetch a replacement.
 */
if (!parentPort) throw err("MODEL_LOAD_FAILED", { detail: "the vision worker was loaded outside a worker thread" })
const port = parentPort

type Library = VisionLibrary & { env: { allowRemoteModels: boolean; allowLocalModels: boolean } }

const TASKS = { "image-feature-extraction": Features, "mask-generation": Segmenter, "depth-estimation": Depth } as const satisfies Record<TaskName, unknown>

const weights = new Map<number, VisionTask>()
const libraries = new Map<string, Promise<Library>>()
let next = 1
/** The request being answered; the next waits for it. */
let queue: Promise<unknown> = Promise.resolve()

function library(entry: string): Promise<Library> {
    let loaded = libraries.get(entry)
    if (!loaded) {
        loaded = import(pathToFileURL(entry).href).then((module: Library) => {
            module.env.allowRemoteModels = false
            module.env.allowLocalModels = true
            return module
        })
        // A failed import is not kept: the next load tries again.
        loaded.catch(() => libraries.delete(entry))
        libraries.set(entry, loaded)
    }
    return loaded
}

function weight(handle: number): VisionTask {
    const found = weights.get(handle)
    if (!found) throw err("MODEL_RUN_FAILED", { detail: `no vision weight ${handle} in this worker — it was disposed, or the worker was replaced` })
    return found
}

async function handle(request: Request): Promise<unknown> {
    if (request.op === "load") {
        const task = await TASKS[request.task].load(await library(request.library), request.path, request.device)
        const handle = next++
        weights.set(handle, task)
        return handle
    }
    if (request.op === "call") return weight(request.handle).call(request.input)
    const task = weight(request.handle)
    weights.delete(request.handle)
    await task.dispose()
    return undefined
}

port.on("message", (request: Request) => {
    queue = queue.then(() => handle(request)).then(
        (value): Response => ({ id: request.id, ok: true, value: value }),
        (cause): Response => ({ id: request.id, ok: false, fault: fault.of(cause) }),
    ).then(response => port.postMessage(response))
})
