import { err } from "@arcforge/err"
import type { AxonOutputEvent, KernelAbi } from "@arcforge/types"

/**
 * The kernel's surface, once — what every language's `kernel` is held to.
 *
 *   effect   needs no answer — an output, letting a handle go, closing a
 *            session: crosses back with the run and is made when it
 *            lands (sync) or as it is made (async). `make` is how.
 *   state    what the body and the sandbox say they are: handed to a run as
 *            it stood when the run started.
 *   call     needs an answer: an async run asks, the host answers. A call
 *            named in `streams` is answered many times — each answer an
 *            event, then an end.
 *
 * A Rust or Python system's effects are checked against this table before
 * anything is made: an unknown verb, or one that is not an effect, is a fault
 * naming the system — never a call the kernel was not designed to take.
 */
export const VERBS = {
    output: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => made.output(args, kernel) },
    emit: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => made.emit(args, kernel) },
    fault: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => made.fault(args, kernel) },
    release: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => kernel.services.release(named(args, "release", "handle")) },
    reset: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => kernel.services.reset(named(args, "reset", "session")) },
    close: { kind: "effect", make: (args: unknown, kernel: KernelAbi) => kernel.services.close(named(args, "close", "session")) },
    body: { kind: "state" },
    presence: { kind: "state" },
    scope: { kind: "state" },
    services: { kind: "state" },
    service: { kind: "call", ops: ["service.call", "service.stream", "service.open", "service.push"] },
    run: { kind: "call", ops: ["run"] },
    store: { kind: "call", ops: ["store.get", "store.set", "store.session"] },
    knowledge: { kind: "call", ops: ["knowledge.list", "knowledge.read", "knowledge.write", "knowledge.remove"] },
    memory: { kind: "call", ops: ["memory.connect"] },
    base: { kind: "call", ops: ["base"] },
} as const

/**
 * How the host answers each call an async Rust or Python run makes — by the
 * operation it names, its arguments an object. Whether a use is available is
 * state, not a call: it crosses with the body's.
 */
const ANSWERS: Record<string, (args: Record<string, unknown>, kernel: KernelAbi) => Promise<unknown>> = {
    "run": (args, kernel) => {
        const code = args.code
        if (typeof code === "string") return kernel.run(code)
        if (Array.isArray(code) && code.every(one => typeof one === "string")) return kernel.run(code)
        throw new Error("run takes { code: string | string[] }")
    },
    "store.get": (args, kernel) => kernel.store.get(text(args, "key") as never),
    "store.set": (args, kernel) => kernel.store.set(text(args, "key") as never, args.value as never),
    "store.session": (args, kernel) => {
        if (args.after !== undefined && typeof args.after !== "number") throw new Error("store.session takes { after?: number }")
        return Promise.resolve(kernel.store.session.get(args.after === undefined ? undefined : { after: args.after }))
    },
    "knowledge.list": (args, kernel) => kernel.knowledge.list({
        ...(typeof args.match === "string" ? { match: args.match } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    }),
    "knowledge.read": (args, kernel) => kernel.knowledge.read(text(args, "name")),
    "knowledge.write": (args, kernel) => kernel.knowledge.write(text(args, "name"), text(args, "content")),
    "knowledge.remove": (args, kernel) => kernel.knowledge.remove(text(args, "name")),
    "memory.connect": (args, kernel) => Promise.resolve(kernel.memory.connect(text(args, "name"))),
    "base": (_args, kernel) => kernel.base(),
    "service.call": (args, kernel) => kernel.services.call(text(args, "use"), text(args, "method"), object(args, "args")),
    "service.open": (args, kernel) => kernel.services.open(text(args, "use"), text(args, "method")),
    "service.push": (args, kernel) => kernel.services.push(text(args, "session"), args.value),
}

/** The calls answered as a stream — each answer an event, until the end. */
const STREAMS: Record<string, (args: Record<string, unknown>, kernel: KernelAbi, signal: AbortSignal) => AsyncIterable<unknown>> = {
    "service.stream": (args, kernel, signal) => kernel.services.stream(text(args, "use"), text(args, "method"), object(args, "args"), signal),
}

/**
 * The table as every language is held to it: what each may send as an effect,
 * read as state, and ask as a call. Pinned in `tests/contract/verbs.json`; the
 * `cognet` crate and the Python runtime each prove they implement exactly this.
 */
export function surface(): { effects: string[]; state: string[]; calls: string[] } {
    const entries = Object.entries(VERBS)
    return {
        effects: entries.filter(([, verb]) => verb.kind === "effect").map(([name]) => name),
        state: entries.filter(([, verb]) => verb.kind === "state").map(([name]) => name),
        calls: entries.flatMap(([, verb]) => "ops" in verb ? [...verb.ops] : []),
    }
}

/** Every call the host can answer — the same list as the table's, or a call it lists would be refused. */
export function answered(): string[] {
    return [...Object.keys(ANSWERS), ...Object.keys(STREAMS)]
}

/** Whether `op` is answered as a stream. */
export function streamed(op: string): boolean {
    return op in STREAMS
}

/** A streamed call an async Rust or Python run made: its answers, until it ends or `signal` stops it. A refusal names the system. */
export async function* stream(system: string, op: string, args: unknown, kernel: KernelAbi, signal: AbortSignal): AsyncIterable<unknown> {
    const answer = STREAMS[op]
    if (!answer) throw err("COGNET_SYSTEM_FAULT", { detail: `${system} asked the kernel to stream ${op}, which is no stream` })
    if (!record(args)) throw err("COGNET_SYSTEM_FAULT", { detail: `${system} asked ${op} with ${JSON.stringify(args)} — a call's arguments are an object` })
    let events: AsyncIterable<unknown>
    try {
        events = answer(args, kernel, signal)
    } catch (cause) {
        if (cause instanceof Error && "code" in cause) throw cause
        throw err("COGNET_SYSTEM_FAULT", { detail: `${system}: ${op}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause })
    }
    yield* events
}

/** A call an async Rust or Python run made: the operation it names, answered through `kernel`. A refusal names the system. */
export async function call(system: string, op: string, args: unknown, kernel: KernelAbi): Promise<unknown> {
    const answer = ANSWERS[op]
    if (!answer) throw err("COGNET_SYSTEM_FAULT", { detail: `${system} asked the kernel for ${op}, which is no call` })
    if (!record(args)) throw err("COGNET_SYSTEM_FAULT", { detail: `${system} asked ${op} with ${JSON.stringify(args)} — a call's arguments are an object` })
    try {
        return await answer(args, kernel)
    } catch (cause) {
        // A structured error from the kernel keeps its code; anything else is the call's own refusal.
        if (cause instanceof Error && "code" in cause) throw cause
        throw err("COGNET_SYSTEM_FAULT", { detail: `${system}: ${op}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause })
    }
}

export type Verb = keyof typeof VERBS

/** The kinds of output an effect may name, as `cognet:output:<kind>`. */
const OUTPUTS = ["text", "audio", "visual", "vector"] as const

/** How each effect is made, through the kernel a system sees — so a sync run's are held like any system's. Private to the table. */
const made = {
    output(args: unknown, kernel: KernelAbi): Promise<void> {
        if (!record(args) || !OUTPUTS.includes(args.type as never) || !record(args.data)) throw invalid("output", "{ type: text | audio | visual | vector, data }")
        return kernel.output(`cognet:output:${args.type}` as keyof AxonOutputEvent, args.data as never)
    },

    emit(args: unknown, kernel: KernelAbi): Promise<void> {
        if (!record(args) || typeof args.type !== "string" || !args.type.startsWith("cognet:")) throw invalid("emit", "{ type: cognet:…, data }")
        kernel.emit(args.type as never, args.data as never)
        return Promise.resolve()
    },

    fault(args: unknown, kernel: KernelAbi): Promise<void> {
        if (!record(args) || typeof args.code !== "string" || typeof args.message !== "string" || (args.excerpt !== undefined && typeof args.excerpt !== "string")) throw invalid("fault", "{ code, message, excerpt? }")
        return kernel.fault({ code: args.code, message: args.message, ...(typeof args.excerpt === "string" ? { excerpt: args.excerpt } : {}) })
    },
}

/** An effect a Rust or Python run returned: checked against the table, then made through `kernel`. */
export function effect(system: string, value: unknown, kernel: KernelAbi): Promise<void> {
    if (!record(value) || typeof value.verb !== "string" || !(value.verb in VERBS)) {
        throw err("COGNET_SYSTEM_FAULT", { detail: `${system} asked the kernel for ${JSON.stringify(record(value) ? value.verb : value)}, which is no kernel verb` })
    }
    const verb = VERBS[value.verb as Verb]
    if (verb.kind !== "effect") throw err("COGNET_SYSTEM_FAULT", { detail: `${system} sent ${value.verb} as an effect — it is a ${verb.kind}` })
    try {
        return verb.make(value.args, kernel)
    } catch (cause) {
        throw err("COGNET_SYSTEM_FAULT", { detail: `${system}: ${cause instanceof Error ? cause.message : String(cause)}`, cause: cause })
    }
}

function text(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    if (typeof value !== "string") throw new Error(`expected ${key} to be text`)
    return value
}

function object(args: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = args[key]
    if (!record(value)) throw new Error(`expected ${key} to be an object of named arguments`)
    return value
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The one id an effect on a session or a handle names. */
function named(args: unknown, verb: string, key: string): string {
    if (!record(args) || typeof args[key] !== "string") throw invalid(verb, `{ ${key} }`)
    return args[key]
}

function invalid(verb: string, shape: string): Error {
    return new Error(`${verb} takes ${shape}`)
}
