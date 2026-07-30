import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"
import type { AxonHandle } from "@arcforge/types"

const argsStorage = new AsyncLocalStorage<Record<string, unknown>>()

/**
 * Fallback for the one place ALS cannot reach: a dynamic `import()`'s module
 * evaluation.
 *
 * Scripts are invoked by importing them, and ALS context does NOT propagate
 * across that boundary in Bun — so `args` read at a script's top level saw an
 * empty object no matter what was passed. The config loader hit the same wall
 * and solved it the same way (see blueprint/scan/config.ts): register on the
 * ALS *and* on a serialized current, and read whichever is populated.
 *
 * Serialized rather than per-call because there is exactly one import in
 * flight per withArgs() — the ALS still owns the concurrent case, this only
 * covers the synchronous module-evaluation window the ALS misses.
 */
let currentArgs: Record<string, unknown> | null = null

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
                get: () => argsStorage.getStore() ?? currentArgs ?? {},
            })
        },

        /** run fn with `args` scoped to this call only — safe under concurrency */
        async withArgs<T>(args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
            const previous = currentArgs
            currentArgs = args
            try {
                return await argsStorage.run(args, fn)
            } finally {
                currentArgs = previous
            }
        },
    }

    return inject
}
