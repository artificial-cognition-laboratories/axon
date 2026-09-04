import { existsSync } from "node:fs"
import { err } from "@arcforge/err"
import { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import type { Inject } from "../../platform"

type ScriptsOpts = {
    blueprint: AxonBlueprint
    inject: ReturnType<typeof Inject>
    /**
     * The durable record, so a script run is a SPAN rather than a silent gap.
     *
     * Without it a script was invisible: it drove the agent, its wakes landed
     * in the log, and nothing said which script had caused them or how long
     * the whole job took. The bracket is also what gives a flame graph its
     * interior — everything the script causes nests inside it by containment,
     * so one opaque bar becomes the tree of what actually happened.
     */
    session: AxonSessionT
}

/**
 * Scripts run in-process, unsandboxed — trusted agent-authored orchestration,
 * not untrusted execution. Sandboxing lives one layer down: a script that
 * calls axon.tools.* gets policy enforcement there. Raw fs/node access from
 * a script is the author's own risk, same as any Node script.
 *
 * A script is a top-level module, not a function export — running it IS
 * importing it. `axon`/`args` are already globals by the time this runs
 * (Inject().runtime() ran at boot); `args` is scoped per-call via
 * withArgs() so concurrent script invocations never race each other's
 * globalThis.args.
 */
/**
 * Capture `console.log`/`console.error` for the duration of a script.
 *
 * Scripts talk through console — that is their existing contract, and every
 * script in the registry is written to it. Captured HERE rather than relying
 * on the capsule's redirect, because the two paths differ: the capsule
 * captures only while a command is executing (`execution.current !== null`),
 * which is true when the TUI runs a script through `link.run` and false for a
 * direct `axon.scripts.request()`. Measured both ways — the direct path wrote
 * to real stdout and emitted nothing at all.
 *
 * Doing it at the one place a script actually starts means every caller gets
 * the same behaviour, rather than the output depending on which door was used.
 *
 * Writes still reach the real stream. A script's logs are its own output and a
 * terminal running one headlessly should still see them; this ADDS the durable
 * record rather than diverting it.
 */
function captureConsole(onLine: (line: { level: "log" | "error"; content: string }) => void): () => void {
    const realLog = console.log
    const realError = console.error

    const format = (args: unknown[]): string =>
        args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")

    console.log = (...args: unknown[]) => {
        onLine({ level: "log", content: format(args) })
        realLog(...args)
    }
    console.error = (...args: unknown[]) => {
        onLine({ level: "error", content: format(args) })
        realError(...args)
    }

    return () => {
        console.log = realLog
        console.error = realError
    }
}

export function Scripts(opts: ScriptsOpts) {
    function find(name: string) {
        const entry = opts.blueprint.scripts.find(s => s.name === name)
        if (!entry) throw err("SCRIPT_NOT_FOUND", { context: { name } })
        if (!entry.filePath || !existsSync(entry.filePath)) {
            throw err("SCRIPT_FILE_NOT_FOUND", { context: { path: entry.filePath ?? "" } })
        }
        return entry
    }

    async function invoke(name: string, args: Record<string, unknown> = {}) {
        const entry = find(name)
        // cache-bust: a script is top-level code, not a function — re-running
        // it means re-executing that code, but dynamic import() caches by
        // resolved specifier, so a second call would silently no-op without this.
        // The same token identifies this invocation's args (see Inject.withArgs):
        // ALS does not survive import(), so the run id is what a top-level
        // `args` read resolves through.
        const runId = crypto.randomUUID()
        const specifier = `${entry.filePath}?run=${runId}`

        /**
         * The span opens BEFORE the import and closes however it settles.
         *
         * Opened first, deliberately: a script that throws on its first line
         * still ran, and a bracket that only opens on success would leave the
         * failure outside any span — unpaired for anything counting depth, and
         * invisible to a reader asking what the user started.
         *
         * `id` rides every member so a surface can correlate the logs and the
         * terminal state back to this one invocation, the same way `commandId`
         * ties capsule work to its block.
         */
        const started = Date.now()
        await opts.session.commit("axon:script:start", { id: runId, name, args })

        const release = captureConsole(line => {
            // Fire-and-forget: a log line must not make the script await the
            // durable write, and ordering is preserved by the session's own
            // serialized writer rather than by this call site.
            void opts.session.commit("axon:script:log", { id: runId, level: line.level, content: line.content })
        })

        try {
            const result = await opts.inject.withArgs(runId, args, () => import(specifier))
            await opts.session.commit("axon:script:complete", { id: runId, durationMs: Date.now() - started })
            return result
        } catch (cause) {
            const failure = err(cause)
            /**
             * Interruption is a SETTLED OUTCOME, not a failure — a script the
             * user stopped did what it was told, and rendering it red would
             * teach them that stopping something is an error.
             *
             * Read off the ORIGINAL cause, not the wrapped error: `err()`
             * returns its own AxonError, so `failure.name` is the wrapper's
             * and an abort was recorded as `:failed`. Checked here rather than
             * inside err() because only this call site knows that a cancelled
             * script is a normal ending.
             */
            const interrupted = cause instanceof Error && cause.name === "AbortError"
            await opts.session.commit(
                interrupted ? "axon:script:interrupted" : "axon:script:failed",
                interrupted
                    ? { id: runId, durationMs: Date.now() - started }
                    : { id: runId, error: failure, durationMs: Date.now() - started },
            )
            throw failure
        } finally {
            release()
        }
    }

    return {
        async request(name: string, args?: Record<string, unknown>) {
            return await invoke(name, args)
        },

        list() {
            return opts.blueprint.scripts
        },
    }
}
