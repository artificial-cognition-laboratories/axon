import { err, errorMap, isAxonError, type AxonError, type AxonErrorCode } from "@arcforge/err"
import type { Change, Component, QueryObservation, Read } from "../ecs"

/**
 * What crosses between the main thread and a worker — the protocol, and the
 * conversions at its two ends. Everything here survives structured clone:
 * component HANDLES become names on the way out and handles again on the way
 * back, and an error becomes a fault that can be revived on the other side.
 */

/** Main → worker: run one system against the world it reads. */
export type Job = {
    kind: "job"
    id: number
    system: string
    now: number
    /** Every entity in the world — a run's `ecs.entity.has` answers from these. */
    entities: string[]
    /** Values the worker does not hold at this version: [component, entity, data, at, rev]. */
    entries: Array<[string, string, unknown, number, number]>
    /** Values the worker holds that the world no longer does: [component, entity]. */
    gone: Array<[string, string]>
    /** The version the world gave the worker's own last writes: [component, entity, rev, at]. */
    confirmed: Array<[string, string, number, number]>
    /** Every value of what it streams, written since it last ran, in order: [component, entity, value, at, rev]. */
    streams: Array<[string, string, unknown, number, number]>
}

/** A Change with its component named rather than held. */
export type WireChange =
    | { op: "set"; entity: string; component: string; data: unknown }
    | { op: "remove"; entity: string; component: string }
    | { op: "add"; entity: string }
    | { op: "drop"; entity: string }

/** Worker → main: how one job ended. */
export type Reply =
    | { kind: "done"; id: number; tid: number | null; changes: WireChange[]; reads: Read[]; queries: QueryObservation[]; at: number; durationMs: number }
    | { kind: "failed"; id: number; tid: number | null; fault: Fault }

/** An error, cloneable. `key` names its entry in the error map when it was a structured one. */
export type Fault = { key?: AxonErrorCode; message: string; stack?: string }

/** Marks a worker as a systems worker in `workerData`, so a bundle can tell why it was loaded. */
export const MARK = "axon.cognet.systems"

export const wire = {
    /** Changes as the worker sends them: components by name. */
    out(list: readonly Change[]): WireChange[] {
        return list.map(change => {
            if (change.op === "set") return { op: "set", entity: change.entity, component: change.component.name, data: change.data }
            if (change.op === "remove") return { op: "remove", entity: change.entity, component: change.component.name }
            return change
        })
    },

    /**
     * Changes as the main thread applies them: names resolved against the
     * system's declared writes. A name outside them is refused here, at the
     * boundary, rather than trusted because the worker is ours.
     */
    in(list: readonly WireChange[], writes: readonly Component<any>[], system: string): Change[] {
        const handles = new Map(writes.map(handle => [handle.name, handle]))
        const handle = (name: string) => {
            const found = handles.get(name)
            if (!found) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${system} wrote "${name}" on a worker without declaring it in writes` })
            return found
        }
        return list.map(change => {
            if (change.op === "set") return { op: "set", entity: change.entity, component: handle(change.component), data: change.data }
            if (change.op === "remove") return { op: "remove", entity: change.entity, component: handle(change.component) }
            return change
        })
    },

    /** An error as it crosses: its map key when structured, its message and stack always. */
    fault(cause: unknown): Fault {
        if (isAxonError(cause)) {
            const key = (Object.keys(errorMap) as AxonErrorCode[]).find(name => errorMap[name].code === cause.code)
            return { ...(key ? { key: key } : {}), message: cause.message, ...(cause.stack ? { stack: cause.stack } : {}) }
        }
        if (cause instanceof Error) return { message: cause.message, ...(cause.stack ? { stack: cause.stack } : {}) }
        return { message: String(cause) }
    },

    /** The fault as an error again, on this side — the same code, the worker's stack. */
    revive(fault: Fault): AxonError {
        const revived = fault.key ? err(fault.key, { detail: fault.message }) : err(Object.assign(new Error(fault.message), fault.stack ? { stack: fault.stack } : {}))
        if (fault.stack) revived.stack = fault.stack
        return revived
    },
}
