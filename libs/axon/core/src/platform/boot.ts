import type { vstr as Vstr } from "@axon/vstr"
import { err } from "@arcforge/err"
import { promptContext } from "../runtime/source/context"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

/**
 * `@axon/vstr` carries the whole Vue toolchain (@vue/compiler-sfc,
 * runtime-core, server-renderer, turndown) — ~280ms of module evaluation, paid
 * at IMPORT time by anything that reached the runtime. Only .vue prompts need
 * it, so an agent with none, and every request that renders a static prompt,
 * was paying for a compiler it never called.
 *
 * Loaded on first render and memoised: the cost moves to the first .vue
 * render and is never paid twice.
 */
let vstrModule: Promise<{ vstr: typeof Vstr }> | null = null
function loadVstr(): Promise<{ vstr: typeof Vstr }> {
    vstrModule ??= import("@axon/vstr")
    return vstrModule
}


type BootOpts = {
    blueprint: AxonBlueprint
    /** Where captured console output from boot.vue's script gets committed. */
    session: AxonSessionT
}

const LOG_LEVELS = ["info", "warning", "error"] as const
type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Boot — the agent's base context. Static `boot.md` is a plain string,
 * read once by the CLI. Dynamic `boot.vue` is a runtime concern: rendered
 * fresh on every tick, with the real `axon` global in scope (read lazily
 * off globalThis — Boot() is constructed before Axon() finishes wiring the
 * handle, so it can never hold a direct reference; by the time render() is
 * actually called, inject.runtime() has already fired).
 *
 * noCache is deliberate — a script-setup call to axon.tools.* must reflect
 * current data on every tick, not a snapshot from the first render.
 *
 * boot.vue's `<script setup>` runs plain console.log/warn/error like any
 * other userland code — those calls must show up as axon:log:* events in
 * the session so the debugger sees them, without losing the real stdout
 * write (a script author tailing their own terminal should still see it).
 * Console is swapped for the duration of this render call only, restored
 * in a finally — same scoped-swap-with-restore shape as the config
 * loader's global patching, never a process-wide patch.
 */
export function Boot(opts: BootOpts) {
    let blueprint = opts.blueprint
    const session = opts.session

    function captureConsole() {
        const original = { log: console.log, warn: console.warn, error: console.error }

        function wrap(level: LogLevel, original_: (...args: unknown[]) => void) {
            return (...args: unknown[]) => {
                original_(...args) // real stdout/stderr write is never blocked
                // console.log cannot be async, so the commit is deliberately
                // fire-and-forget. The catch is not optional: commit() rejects
                // on a disk failure, and without it a full disk turns every
                // console.log in boot.vue into an unhandled rejection that
                // crashes the process. Losing one captured log line is the
                // right trade against that — the real stdout write above
                // already happened.
                void session.commit(`axon:log:${level}`, { value: args.length === 1 ? args[0] : args })
                    .catch(() => {})
            }
        }

        console.log = wrap("info", original.log)
        console.warn = wrap("warning", original.warn)
        console.error = wrap("error", original.error)

        return () => {
            console.log = original.log
            console.warn = original.warn
            console.error = original.error
        }
    }

    async function render(): Promise<string | undefined> {
        if (blueprint.boot !== undefined) return blueprint.boot
        if (blueprint.bootFilePath === undefined) return undefined

        const restore = captureConsole()
        try {
            return await (await loadVstr()).vstr(blueprint.bootFilePath, {
                context: promptContext(blueprint),
                noCache: true,
            }).render()
        } catch (cause) {
            // vstr (generic tool, no @axon/err) throws plain on a malformed
            // boot.vue — wrap at the boundary into the structured code.
            throw err("BOOT_SCRIPT_INVALID", { cause, context: { path: blueprint.bootFilePath } })
        } finally {
            restore()
        }
    }

    return {
        render,

        /** the agent changed: adopt the new blueprint — next render, never mid-render */
        update(next: AxonBlueprint) {
            blueprint = next
        },
    }
}

export type AxonBootT = ReturnType<typeof Boot>
