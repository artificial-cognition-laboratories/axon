import { err, errorMap, isAxonError, type AxonError, type AxonErrorCode } from "@arcforge/err"
import type { Device } from "./types"

/**
 * What crosses between the daemon's thread and a vision worker. Everything
 * here survives structured clone: a failure becomes a fault that the other
 * side revives into the same error.
 */

/** The image tasks a worker can load. */
export type TaskName = "image-feature-extraction" | "mask-generation" | "depth-estimation"

export type Request =
    /** Import the library at `library` if this worker has not, load the weight, and answer with its handle. */
    | { id: number; op: "load"; library: string; task: TaskName; path: string; device: Device }
    | { id: number; op: "call"; handle: number; input: unknown }
    /** Release the weight. The worker stays: it serves every weight. */
    | { id: number; op: "dispose"; handle: number }

/** A request without the id `Calls` gives it. */
export type Ask = Request extends infer each ? (each extends Request ? Omit<each, "id"> : never) : never

export type Response =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; fault: Fault }

/** An error, cloneable. `key` names its entry in the error map when it was a structured one. */
export type Fault = { key?: AxonErrorCode; message: string; stack?: string }

export const fault = {
    /** An error as it crosses: its map key when structured, its message and stack always. */
    of(cause: unknown): Fault {
        if (isAxonError(cause)) {
            const key = (Object.keys(errorMap) as AxonErrorCode[]).find(name => errorMap[name].code === cause.code)
            return { ...(key ? { key: key } : {}), message: cause.message, ...(cause.stack ? { stack: cause.stack } : {}) }
        }
        if (cause instanceof Error) return { message: cause.message, ...(cause.stack ? { stack: cause.stack } : {}) }
        return { message: String(cause) }
    },

    /** The fault as an error again, on this side — the same code, the worker's stack. */
    revive(value: Fault): AxonError {
        const revived = value.key ? err(value.key, { detail: value.message }) : err(Object.assign(new Error(value.message), value.stack ? { stack: value.stack } : {}))
        if (value.stack) revived.stack = value.stack
        return revived
    },
}
