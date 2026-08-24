import { AsyncLocalStorage } from "node:async_hooks"

/** Wake-local context, preserved independently across concurrent commands. */
export function Execution() {
    const storage = new AsyncLocalStorage<{ id: string; signal: AbortSignal }>()

    return {
        run<T>(id: string, signal: AbortSignal, fn: () => T): T {
            return storage.run({ id, signal }, fn)
        },
        get current() {
            return storage.getStore() ?? null
        },
    }
}

export type ExecutionT = ReturnType<typeof Execution>
