import { AsyncResource } from "node:async_hooks"
import { isMainThread } from "node:worker_threads"
import { err } from "@arcforge/err"
import type { KernelAbi, ServiceState } from "@arcforge/types"
import { effects } from "./effects"
import { definitions, type Component, type EcsT } from "./ecs"
import { clock, defineSystem, stimuli, type Input, type NamedSystem, type Readable, type Run, type Trigger } from "./schedule"
import { Conversation } from "./conversation"
import { call, effect, stream } from "./verbs"
import { Gate } from "./services"
import { wire, type Packed } from "./wire"

/**
 * The version of the run protocol this runtime speaks — the snapshot it sends
 * and the reply it reads. The `cognet` crate and the Python runtime each
 * declare the one they were built against; a module whose number differs is
 * refused at load, because every run it made would fail.
 */
export const PROTOCOL = 3

/**
 * A cognet's compiled native module, as the generated entry loads it: one
 * `.node` holding every `*.system.rs`. See the `cognet` crate's `serve`.
 */
export type NativeModule = {
    /** The run protocol it was built against. Absent from a module built before the protocol was versioned. */
    protocol(): unknown
    /** Every system it holds: `[name, declaration]`, its name its path. */
    declarations(): unknown
    /**
     * One run of the system named `name`: handed its snapshot as JSON, and
     * the bytes of every typed array the JSON marks (`{"$array": i}`) with
     * each one's kind; answers `{ changes, arrays }`, the changes as JSON
     * marking the arrays the same way. Throws its fault.
     */
    run(name: string, snapshot: string, kinds: string[], arrays: Uint8Array[]): unknown
    /** Where an async system's messages go while it runs. Called once, before any is told a job. */
    listen(heard: (text: string) => void): void
    /** A job, an answer or a cancel, for an async system. Throws when the module cannot read it. */
    tell(text: string): void
}

/**
 * What a process run can reach while it is going: the wake's signal, which
 * cancels it; the kernel's calls, answered here; and its effects, made as they
 * arrive — an async run's leave as it makes them.
 */
export type Session = {
    signal: AbortSignal
    call(op: string, args: unknown): Promise<unknown>
    /** A call answered as a stream, until it ends or `signal` stops it. */
    stream(op: string, args: unknown, signal: AbortSignal): AsyncIterable<unknown>
    effect(value: unknown): Promise<void>
}

/** A process-backed module speaks the same declarations and value exchange, asynchronously. */
export type AsyncNativeModule = {
    protocol(): unknown
    /** Goes up each time the process behind it restarts — a new process holds no kernel state. */
    epoch(): number
    declarations(): unknown
    run(name: string, snapshot: string, kinds: string[], arrays: Uint8Array[], session: Session): Promise<unknown>
}

/**
 * What a native run is handed: the tick's time, the entities it can see,
 * every value it declared, `[component, entity, value]`, and every component
 * it streams with each value written since it last ran, `[component,
 * [[entity, value, at], ...]]`.
 */
export type Snapshot = {
    now: number
    entities: string[]
    entries: Array<[string, string, unknown]>
    reads: string[]
    writes: string[]
    streams: Array<[string, Array<[string, unknown, number]>]>
    stimuli?: readonly unknown[]
    /** The kernel's state, when it changed since the module last saw it — `services` is each declared use, as it stands. */
    state?: { rev: number; body: unknown; presence: unknown; scope: unknown; services: Readonly<Record<string, ServiceState>> }
}

/** What a run hands back: its changes, and the effects it asked the kernel for, in order. */
export type Returned = { changes: unknown[]; effects: unknown[] }

/** A declaration as the module says it: every handle by name. `streams` and `lag` are absent from a module built before them. */
type Declared = { on?: string[]; reads: string[]; streams?: string[]; recalls: string[]; writes: string[]; uses?: string[]; once: boolean; thread?: "worker"; lag?: number; async?: boolean }

/** A change as the module says it: what a worker's reply carries. */
type Said = { op: "set"; entity: string; component: string; data: unknown } | { op: "remove"; entity: string; component: string }

/**
 * Native — a compiled module's systems as ordinary systems.
 *
 * Each becomes a `defineSystem` whose run hands the module an owned snapshot
 * of exactly what it declared — read through the ambient `ecs`, as any
 * system reads — and writes what it returns through the ambient `ecs`, as
 * any system writes. So the schedule, isolation, enforcement and the run
 * record treat it like every other system, on the main thread or a worker,
 * and never learn it is native. The module cannot reach what it did not
 * declare: it is never given it, and a write outside `writes` is refused by
 * the same enforcement a TypeScript system's is.
 *
 * Called by `Discovered`, after every handle is named — a declaration names
 * its handles by their full names, which only exist from then on.
 */
export function Native(opts: { module: NativeModule }) {
    const states = States()
    return {
        /** Every system the module holds, named and ready to schedule — an `async fn` as an async system. */
        systems(): NamedSystem[] {
            const declared = listed(opts.module)
            const talking = declared.some(([, one]) => one.async) ? conversing(opts.module) : null
            return declared.map(([name, one]) => ({
                name: name,
                system: one.async ? asyncSystem(talking!, name, one, states) : system(opts.module, name, one, states),
            }))
        },
    }
}

/**
 * The module's async systems as a process's are: the same conversation, over
 * the module's own ear (`listen`) and voice (`tell`) instead of a pipe. A
 * message the module cannot be told, or says wrongly, fails every run in it.
 */
function conversing(module: NativeModule): AsyncNativeModule {
    const conversation = Conversation({ send: told => module.tell(JSON.stringify(told)), failing: "COGNET_SYSTEM_FAULT" })
    module.listen(text => {
        try {
            conversation.heard(text)
        } catch (cause) {
            conversation.fail(cause instanceof Error ? cause : new Error(String(cause)))
        }
    })
    return {
        protocol: () => module.protocol(),
        // In this process for good: never restarted, so never in need of the state again.
        epoch: () => 0,
        declarations: () => module.declarations(),
        run: (name, snapshot, kinds, arrays, session) => conversation.begin(name, snapshot, kinds, arrays, session),
    }
}

/** Process systems use the native data contract while their run awaits a reply. */
export function AsyncNative(opts: { module: AsyncNativeModule }) {
    const states = States()
    return {
        systems(): NamedSystem[] {
            return listed(opts.module).map(([name, declared]) => ({ name: name, system: asyncSystem(opts.module, name, declared, states) }))
        },
    }
}

/** Every system a module declares, once it has said it speaks this runtime's protocol. */
function listed(module: NativeModule | AsyncNativeModule): Array<[string, Declared]> {
    agreed(module)
    const declared = module.declarations()
    if (!Array.isArray(declared)) throw invalid("its declarations() returned something other than a list")
    return declared.map(entry => {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !said.declared(entry[1])) throw invalid(`it declared ${JSON.stringify(entry)}, which is no system's declaration`)
        return [entry[0], entry[1]]
    })
}

/** One native system as a system: its handles resolved by name, its run a call into the module. */
function system(module: NativeModule, name: string, declared: Declared, states: StatesT) {
    const shape = shaped(declared)
    return defineSystem({
        ...shape.spec,
        ...(declared.thread ? { thread: declared.thread } : {}),
        run(run) {
            // A sync run's effects are held and made when it lands; held, sending one cannot fail here.
            if (!effects.holding()) throw err("COGNET_SYSTEM_FAULT", { detail: `${name} ran where its effects could not be held` })
            const ran = blocks.exchange(module, name, runs.snapshot(shape, declared, run, states))
            runs.land(name, ran.changes)
            for (const one of ran.effects) void effect(name, one, runs.kernel())
        },
    })
}

/** A process run has the same snapshot and landing checks as a native run; its effects leave as they arrive. */
function asyncSystem(module: AsyncNativeModule, name: string, declared: Declared, states: StatesT) {
    const shape = shaped(declared)
    return defineSystem({
        ...shape.spec,
        async run(run) {
            // Its services, gated to the uses it declared: the same gate a TypeScript run's go through, ended with it.
            const gate = Gate({ system: name, uses: declared.uses ?? [], calls: true, services: runs.kernel().services })
            const kernel: KernelAbi = { ...runs.kernel(), services: gate }
            // Bound to this run's context: what it asks arrives on a pipe or a native thread's callback, outside any
            // wake, and must still reach the kernel as the wake that started it.
            const scope = new AsyncResource("cognet.run")
            const session: Session = {
                signal: run.signal,
                call: (op, args) => scope.runInAsyncScope(() => call(name, op, args, kernel)),
                stream: (op, args, signal) => runs.within(scope, () => stream(name, op, args, kernel, signal)),
                effect: one => scope.runInAsyncScope(() => effect(name, one, kernel)),
            }
            const ran = await blocks.exchangeAsync(module, name, runs.snapshot(shape, declared, run, states, module.epoch()), session).finally(() => gate.end())
            runs.land(name, ran.changes)
            // What it sent as it went has already been made; what a sync function returned is made now, in order.
            for (const one of ran.effects) await effect(name, one, kernel)
        },
    })
}

type Shape = ReturnType<typeof shaped>

/** What a native run is handed and what it hands back — one way for both transports. Private to Native. */
const runs = {
    /** The snapshot of exactly what it declared, with the stimuli it reads and the state it has not yet seen. */
    snapshot(shape: Shape, declared: Declared, run: Run, states: StatesT, epoch = 0): Snapshot {
        const ecs = handles.world()
        const entries: Snapshot["entries"] = []
        const entities = new Set(ecs.entity.all())
        for (const handle of shape.given) {
            const key = definitions.key(handle)
            for (const row of ecs.query({ components: [handle.name] })) {
                entries.push([handle.name, row.id, row[key]])
                entities.add(row.id)
            }
        }
        const state = isMainThread ? states.next(runs.kernel(), epoch) : null
        return {
            now: run.now,
            entities: [...entities],
            entries: entries,
            reads: shape.given.map(handle => handle.name),
            writes: shape.writes.map(handle => handle.name),
            streams: shape.streams.map(handle => [handle.name, run.since(handle).map((one): [string, unknown, number] => [one.entity, one.value, one.at])]),
            ...(declared.reads.includes("stimuli") ? { stimuli: run.stimuli } : {}),
            ...(state ? { state: state } : {}),
        }
    },

    /** Its changes, through the world — refused by the same enforcement as any system's when undeclared. */
    land(name: string, changes: unknown[]): void {
        const ecs = handles.world()
        for (const change of changes) {
            if (!said.change(change)) throw invalid(`${name} returned ${JSON.stringify(change)}, which is no change`)
            ecs.set({ id: change.entity, components: { [change.component]: change.op === "set" ? change.data : null } })
        }
    },

    /** A stream whose every step runs in `scope` — the run's context — wherever it is pulled from. */
    within<T>(scope: AsyncResource, open: () => AsyncIterable<T>): AsyncIterable<T> {
        return {
            [Symbol.asyncIterator]() {
                const steps = scope.runInAsyncScope(() => open()[Symbol.asyncIterator]())
                return {
                    next: () => scope.runInAsyncScope(() => steps.next()),
                    return: (value?: unknown) => scope.runInAsyncScope(() => steps.return?.(value) ?? Promise.resolve({ done: true as const, value: value as T })),
                }
            },
        }
    },

    /** The kernel every system reaches: the ambient one the host installs. */
    kernel(): KernelAbi {
        const found: unknown = Reflect.get(globalThis, "kernel")
        if (!said.kernel(found)) throw err("COGNET_WORKER_FAILED", { detail: "a native system reached for the kernel where there is none — on a worker, or before load" })
        return found
    },
}

/** A declaration's handles, resolved by name, and the spec a TypeScript system would have written. */
function shaped(declared: Declared) {
    const reads = declared.reads.map(handles.readable)
    const streams = (declared.streams ?? []).map(handles.component)
    const recalls = declared.recalls.map(handles.component)
    const writes = declared.writes.map(handles.component)
    return {
        // Everything it is given each run: its reads' and recalls' components, never an input.
        given: handles.given(reads, recalls),
        streams: streams,
        writes: writes,
        spec: {
            ...(declared.on ? { on: declared.on.map(handles.readable) satisfies Trigger[] } : {}),
            ...(declared.once ? { once: true } : {}),
            reads: reads,
            ...(streams.length > 0 ? { streams: streams } : {}),
            recalls: recalls,
            writes: writes,
            ...(declared.uses?.length ? { uses: declared.uses } : {}),
            ...(declared.lag ? { lag: declared.lag } : {}),
        },
    }
}

/**
 * The kernel's state a module has been handed — private to Native. Sent with
 * a run only when it has changed since the module last saw it, so a body's
 * manifest crosses once, not twenty times a second; the module keeps the last
 * it was given, and every run reads the state as it stood when the run began.
 */
function States() {
    let rev = 0
    let last: { body: unknown; presence: unknown; scope: unknown; services: string; epoch: number } | null = null
    return {
        /** `epoch` names the process the module runs in: a restarted one is sent the state again. */
        next(kernel: KernelAbi, epoch: number): NonNullable<Snapshot["state"]> | null {
            const now = { body: kernel.body(), presence: kernel.presence(), scope: kernel.scope(), services: kernel.services.state() }
            const services = JSON.stringify(now.services)
            if (last && last.epoch === epoch && last.body === now.body && last.presence === now.presence && last.scope === now.scope && last.services === services) return null
            last = { body: now.body, presence: now.presence, scope: now.scope, services: services, epoch: epoch }
            rev += 1
            return { rev: rev, ...now }
        },
    }
}

type StatesT = ReturnType<typeof States>

/** What a declaration names, as this side holds it — private to Native. */
const handles = {
    /** The components a declaration reads, including every member of a query. */
    given(reads: readonly Readable[], recalls: readonly Component<unknown>[]): Component<unknown>[] {
        const members = [...reads, ...recalls].flatMap(handle => handle.kind === "input" ? [] : definitions.members(handle))
        return [...new Map(members.map(handle => [handle.name, handle])).values()]
    },

    /** A name a declaration reads or is run by: an input, or a component. */
    readable(name: string): Readable {
        const input = INPUTS.find(one => one.name === name)
        return input ?? handles.component(name)
    },

    component(name: string): Component<unknown> {
        return definitions.find(name)
    },

    /** The world, as every system reaches it: the ambient `ecs` the host installs. */
    world(): EcsT {
        const found: unknown = Reflect.get(globalThis, "ecs")
        if (!handles.installed(found)) throw err("COGNET_WORKER_FAILED", { detail: "a native system ran where there is no world — the cognet host is not installed" })
        return found
    },

    installed(value: unknown): value is EcsT {
        return typeof value === "object" && value !== null && "query" in value && "set" in value
    },
}

const INPUTS: readonly Input[] = [clock, stimuli]

/** One run across the boundary, either transport: the snapshot out, what it did back. Private to Native. */
const blocks = {
    exchange(module: NativeModule, name: string, snapshot: Snapshot): Returned {
        const packed = blocks.pack(snapshot, name)
        return blocks.returned(name, faulted(name, () => module.run(name, packed.json, packed.kinds, packed.arrays)))
    },

    /** Through a process: the run may ask the kernel things while it is going, through `session`. */
    async exchangeAsync(module: AsyncNativeModule, name: string, snapshot: Snapshot, session: Session): Promise<Returned> {
        const packed = blocks.pack(snapshot, name)
        return blocks.returned(name, await faultedAsync(name, () => module.run(name, packed.json, packed.kinds, packed.arrays, session)))
    },

    /**
     * The snapshot as JSON, every component value's arrays lifted out. Value
     * by value, never the envelope whole: an entry is a tuple whose first
     * element is a name, which the shortcut for a list of plain values would
     * take for a list of names and never look inside.
     */
    pack(snapshot: Snapshot, name: string): Packed {
        const into: Omit<Packed, "json"> = { kinds: [], arrays: [] }
        const entries = snapshot.entries.map(([component, entity, value]) => [component, entity, wire.lift(value, into, name)])
        const streams = snapshot.streams.map(([component, written]) => [component, written.map(([entity, value, at]) => [entity, wire.lift(value, into, name), at])])
        return { json: JSON.stringify({ ...snapshot, entries: entries, streams: streams }), kinds: into.kinds, arrays: into.arrays }
    },

    returned(name: string, ran: unknown): Returned {
        if (!said.ran(ran)) throw invalid(`${name} answered something other than { ran, arrays }`)
        const returned = wire.unpack(ran.ran, ran.arrays, name)
        if (!said.returned(returned)) throw invalid(`${name} returned something other than { changes: [...], effects: [...] }`)
        return returned
    },
}

/** What the module says, checked at the boundary — private to Native. Nothing it returns is trusted because it is ours. */
const said = {
    declared(value: unknown): value is Declared {
        if (typeof value !== "object" || value === null) return false
        const names = (field: unknown) => Array.isArray(field) && field.every(one => typeof one === "string")
        return "reads" in value && names(value.reads) && "recalls" in value && names(value.recalls) && "writes" in value && names(value.writes) && "once" in value && typeof value.once === "boolean"
            && (!("on" in value) || names(value.on)) && (!("thread" in value) || value.thread === "worker")
            && (!("streams" in value) || names(value.streams)) && (!("lag" in value) || (typeof value.lag === "number" && Number.isInteger(value.lag) && value.lag >= 0))
            && (!("async" in value) || typeof value.async === "boolean")
    },

    change(value: unknown): value is Said {
        if (typeof value !== "object" || value === null || !("op" in value) || !("entity" in value) || !("component" in value)) return false
        return (value.op === "set" && "data" in value || value.op === "remove") && typeof value.entity === "string" && typeof value.component === "string"
    },

    ran(value: unknown): value is { ran: string; arrays: ArrayBufferView[] } {
        return typeof value === "object" && value !== null && "ran" in value && typeof value.ran === "string"
            && "arrays" in value && Array.isArray(value.arrays) && value.arrays.every(one => ArrayBuffer.isView(one))
    },

    kernel(value: unknown): value is KernelAbi {
        return typeof value === "object" && value !== null && "output" in value && "body" in value && "presence" in value && "scope" in value && "engine" in value
    },

    returned(value: unknown): value is Returned {
        return typeof value === "object" && value !== null && "changes" in value && Array.isArray(value.changes) && "effects" in value && Array.isArray(value.effects)
    },

}

/** The module speaks this runtime's protocol, or the mind does not load. */
function agreed(module: { protocol?: () => unknown }): void {
    if (typeof module.protocol !== "function") {
        throw err("COGNET_PROTOCOL_MISMATCH", { detail: `the cognet's native module says no protocol — it was built before the run protocol was versioned; this runtime speaks ${PROTOCOL}` })
    }
    const spoken = module.protocol()
    if (spoken !== PROTOCOL) {
        throw err("COGNET_PROTOCOL_MISMATCH", { detail: `the cognet's native module was built against protocol ${String(spoken)}; this runtime speaks ${PROTOCOL}` })
    }
}

/** A run's own failure — a Rust fault or panic, a Python exception — as a structured fault naming the system. */
function faulted<T>(name: string, run: () => T): T {
    try {
        return run()
    } catch (cause) {
        throw err("COGNET_SYSTEM_FAULT", { detail: `${name}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause })
    }
}

async function faultedAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run()
    } catch (cause) {
        throw err("COGNET_SYSTEM_FAULT", { detail: `${name}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause })
    }
}

function invalid(why: string): Error {
    return err("COGNET_DISCOVERY_INVALID", { detail: `the cognet's native module is not what this runtime expects: ${why}` })
}
