import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@axon/err"
import type { AxonHandle } from "@arcforge/types"

const argsStorage = new AsyncLocalStorage<Record<string, unknown>>()

/**
 * Owns every global mutation in the runtime. All globalThis writes live
 * here, nowhere else — this is the one place to audit for it.
 *
 * Two phases, same pattern as the old inject.ts:
 *   macros()  — noop globals, safe to import before the runtime exists.
 *               Any call throws INJECT_OUTSIDE_RUNTIME.
 *   runtime() — swaps in the live handle once Axon() has fully built it.
 *
 * `args` is scoped per-invocation via AsyncLocalStorage instead of a bare
 * save/restore on globalThis — two concurrent script/tool calls each get
 * their own args, no race between them regardless of interleaving.
 */
export function Inject() {
    function outsideRuntime(): never {
        throw err("INJECT_OUTSIDE_RUNTIME")
    }

    const inject = {
        macros() {
            const g = globalThis as Record<string, unknown>

            g.axon = new Proxy({}, {
                get: outsideRuntime,
            })

            Object.defineProperty(g, "args", {
                configurable: true,
                get: outsideRuntime,
            })
        },

        runtime(axon: AxonHandle) {
            const g = globalThis as Record<string, unknown>

            g.axon = axon

            Object.defineProperty(g, "args", {
                configurable: true,
                get: () => argsStorage.getStore() ?? {},
            })
        },

        /** run fn with `args` scoped to this call only — safe under concurrency */
        withArgs<T>(args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
            return argsStorage.run(args, fn)
        },
    }

    return inject
}
