import { AsyncLocalStorage } from "node:async_hooks"
import type { CapsuleEvent } from "../../types"
import type { SandboxWireT } from "./wire"

type ConsoleOpts = {
    wire: SandboxWireT
}

const LEVELS = ["log", "info", "warn", "error", "debug"] as const
type Level = (typeof LEVELS)[number]

/**
 * Console — redirects the sandbox's console.* away from real stdout (the
 * protocol wire) into capsule:console events. Run() executes each command
 * inside runs.run(id, ...) so concurrent runs each attribute their console
 * calls to the correct commandId — global console state, correctly scoped
 * per call via AsyncLocalStorage rather than a shared mutable "current id".
 */
export function Console(opts: ConsoleOpts) {
    const { wire } = opts
    const runs = new AsyncLocalStorage<string>()

    const original: Record<Level, (...args: unknown[]) => void> = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
    }

    for (const level of LEVELS) {
        console[level] = (...args: unknown[]) => {
            const commandId = runs.getStore() ?? null
            wire.emit("capsule:console", { level, commandId, args } satisfies CapsuleEvent["capsule:console"])
        }
    }

    return {
        /** Run fn with commandId attributed to every console.* call inside it, including across awaits. */
        run<T>(commandId: string, fn: () => Promise<T>): Promise<T> {
            return runs.run(commandId, fn)
        },

        /** Capture process.stdout/stderr writes without touching the protocol streams. */
        write(level: "log" | "error", data: string | Uint8Array): boolean {
            const commandId = runs.getStore() ?? null
            const content = typeof data === "string" ? data : new TextDecoder().decode(data)
            wire.emit("capsule:console", { level, commandId, args: [content] })
            return true
        },

        /** Restore the real console.* — used by tests, never called in production. */
        restore(): void {
            for (const level of LEVELS) console[level] = original[level]
        },
    }
}

export type ConsoleT = ReturnType<typeof Console>
