import { err } from "@arcforge/err"
import type { KernelServices } from "@arcforge/types"

type GateOpts = {
    /** The system the run is of — what a refusal names. */
    system: string
    /** The uses it declared: it reaches these and no others. */
    uses: readonly string[]
    /** Whether the run is async — the only kind that may make a call, which needs an answer. */
    calls: boolean
    services: KernelServices
}

/**
 * Gate — the kernel's services as one run reaches them.
 *
 * A run reaches only the uses its system declared: a call to any other is
 * refused before it is made, never after it has cost something. Every handle
 * the run is handed is remembered, and `end` releases whichever it did not —
 * a handle lasts no longer than the run that made it.
 *
 * The same gate serves a TypeScript run's `services` and a Rust or Python
 * run's calls, so the rule is one rule in every language.
 */
export function Gate(opts: GateOpts) {
    /** Handles this run was handed and has not released. */
    const made = new Set<string>()

    return {
        state: () => opts.services.state(),

        async call(use: string, method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
            reaching(use, method)
            return kept(await opts.services.call(use, method, args, signal))
        },

        async *stream(use: string, method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
            reaching(use, method)
            for await (const answer of opts.services.stream(use, method, args, signal)) yield kept(answer)
        },

        open(use, method) {
            reaching(use, method)
            return opts.services.open(use, method)
        },

        async push(session, value) {
            return kept(await opts.services.push(session, value))
        },

        reset: session => opts.services.reset(session),
        close: session => opts.services.close(session),

        release(handle) {
            made.delete(handle)
            return opts.services.release(handle)
        },

        /** The run is over: every handle it still holds is let go. */
        async end(): Promise<void> {
            const left = [...made]
            made.clear()
            await Promise.all(left.map(handle => opts.services.release(handle)))
        },
    } satisfies KernelServices & { end(): Promise<void> }

    function reaching(use: string, method: string): void {
        if (!opts.uses.includes(use)) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} called ${use}.${method} without declaring \`uses: ["${use}"]\`` })
        if (!opts.calls) throw err("COGNET_UNDECLARED_ACCESS", { detail: `${opts.system} called ${use}.${method}, which needs an answer — only an async system makes calls` })
    }

    /** An answer, every handle in it remembered as this run's. */
    function kept<T>(answer: T): T {
        for (const handle of handles(answer)) made.add(handle)
        return answer
    }
}

export type GateT = ReturnType<typeof Gate>

/** Every handle's id in a value. Typed arrays and other memory are never looked inside. */
function handles(value: unknown): string[] {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return []
    if (Array.isArray(value)) return value.flatMap(handles)
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 2 && typeof record.handle === "string" && typeof record.id === "string") return [record.id]
    return Object.values(record).flatMap(handles)
}
