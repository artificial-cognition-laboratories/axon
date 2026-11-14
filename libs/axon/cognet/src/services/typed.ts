import { err } from "@arcforge/err"
import type { CognetUse, ServiceState } from "@arcforge/types"
import type { GateT } from "./gate"

/** One use as a TypeScript run holds it: its state, and its interface's methods by name. */
export type RunUse = {
    /** Whether something fills it, as it stood when the run began. */
    readonly available: boolean
    /** What the granted provider reports of itself — null while unavailable. */
    describe(): Readonly<Record<string, unknown>> | null
    readonly [method: string]: unknown
}

/** A run's services: one per use its system declared. */
export type RunServices = Readonly<Record<string, RunUse>>

/** An open session, as a run holds it. */
export type RunSession = {
    push(value: unknown): Promise<unknown>
    reset(): Promise<void>
    close(): Promise<void>
}

type TypedOpts = {
    system: string
    /** The uses its system declared. */
    declared: readonly string[]
    /** Every use the cognet declared, joined to its interface as compiled. */
    uses: Readonly<Record<string, CognetUse>>
    gate: GateT
}

/**
 * Typed — a run's `services`: each use its system declared, each method of its
 * interface a function. A call's arguments are positional, as the interface
 * writes them, and cross as one object keyed by its parameter names. Every
 * handle in an answer can be released; every other use is refused by name.
 */
export function Typed(opts: TypedOpts): RunServices {
    /** The services as they stood when the run began, read once — a run sees one state throughout. */
    let state: Readonly<Record<string, ServiceState>> | null = null
    const now = (): Readonly<Record<string, ServiceState>> => state ??= opts.gate.state()

    const held = Object.fromEntries(opts.declared.map(name => [name, use(name)]))
    return new Proxy(held, {
        get(target, name) {
            if (typeof name !== "string" || name in target) return Reflect.get(target, name)
            throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} reached services.${name} without declaring \`uses: ["${name}"]\`` })
        },
    })

    function use(name: string): RunUse {
        const declared = opts.uses[name]
        if (!declared) throw err("COGNET_SCHEDULE_INVALID", { detail: `${opts.system} uses ${name}, which cognet.config.ts does not declare in uses` })
        const methods = Object.fromEntries(Object.entries(declared.methods)
            .filter(([, method]) => method.kind !== "describe")
            .map(([method, shape]) => [method, dispatch(name, method, shape)]))
        return {
            ...methods,
            get available() {
                return stateOf(name).available
            },
            describe: () => stateOf(name).describe,
        }
    }

    function stateOf(name: string): ServiceState {
        const found = now()[name]
        if (!found) throw err("COGNET_SCHEDULE_INVALID", { detail: `the kernel holds no state for ${name}` })
        return found
    }

    function dispatch(use: string, method: string, shape: CognetUse["methods"][string]): unknown {
        if (shape.kind === "call") return (...args: unknown[]) => opts.gate.call(use, method, keyed(shape.params, args)).then(releasable)
        if (shape.kind === "stream") return (...args: unknown[]) => streamed(opts.gate.stream(use, method, keyed(shape.params, args)))
        return () => session(opts.gate.open(use, method))
    }

    async function* streamed(answers: AsyncIterable<unknown>): AsyncIterable<unknown> {
        for await (const answer of answers) yield releasable(answer)
    }

    /** A session opened now, pushed to once it is. */
    function session(opening: Promise<string>): RunSession {
        return {
            push: async value => releasable(await opts.gate.push(await opening, value)),
            reset: async () => opts.gate.reset(await opening),
            close: async () => opts.gate.close(await opening),
        }
    }

    /** An answer, every handle in it given a `release` — not enumerable, so the handle still crosses as `{ handle, id }`. */
    function releasable<T>(value: T): T {
        if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
        if (Array.isArray(value)) {
            value.forEach(releasable)
            return value
        }
        const record = value as Record<string, unknown>
        if (Object.keys(record).length === 2 && typeof record.handle === "string" && typeof record.id === "string") {
            const id = record.id
            Object.defineProperty(record, "release", { value: () => opts.gate.release(id), enumerable: false })
            return value
        }
        Object.values(record).forEach(releasable)
        return value
    }
}

/** Positional arguments, as the one object a call crosses as — keyed by the interface's parameter names. */
function keyed(params: readonly string[], args: readonly unknown[]): Record<string, unknown> {
    if (args.length > params.length) throw err("SERVICE_INVALID", { detail: `called with ${args.length} arguments; it takes ${params.length}: ${params.join(", ")}` })
    return Object.fromEntries(params.flatMap((param, index) => args[index] === undefined ? [] : [[param, args[index]]]))
}
