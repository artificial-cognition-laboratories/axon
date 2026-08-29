import { AsyncLocalStorage } from "node:async_hooks"
import type { CapsuleEvent } from "../../types"
import type { InProcWireT as SandboxWireT } from "../inproc/emitter"

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

    /**
     * `console.*` is captured only while a COMMAND is running.
     *
     * Replacing it outright was correct in a subprocess the capsule owned: no
     * other code ran there, so every console call was model code by
     * definition. In one heap the host shares this console — the TUI, a test
     * runner, the runtime's own diagnostics — and an unconditional replace
     * silenced all of it for as long as an agent existed.
     *
     * `runs.getStore()` already answers the question: inside a command it is
     * that command's id, outside one it is null. So a null store means the
     * write belongs to the host and goes to the real console, which is the
     * distinction the original replace assumed could never arise.
     */
    for (const level of LEVELS) {
        console[level] = (...args: unknown[]) => {
            const commandId = runs.getStore() ?? null
            if (commandId === null) {
                original[level](...args)
                return
            }
            wire.emit("process:console", { level, commandId, args } satisfies CapsuleEvent["process:console"])
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
            wire.emit("process:console", { level, commandId, args: [content] })
            return true
        },

        /** Restore the real console.* — used by tests, never called in production. */
        restore(): void {
            for (const level of LEVELS) console[level] = original[level]
        },
    }
}

export type ConsoleT = ReturnType<typeof Console>
