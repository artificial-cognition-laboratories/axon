import { existsSync } from "node:fs"
import { err } from "@arcforge/err"
import { AxonBlueprint } from "@arcforge/types"
import type { Inject } from "../../platform"

type ScriptsOpts = {
    blueprint: AxonBlueprint
    inject: ReturnType<typeof Inject>
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
        return opts.inject.withArgs(runId, args, () => import(specifier))
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
