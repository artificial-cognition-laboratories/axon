import type { AxonTool } from "@arcforge/types"
import { isLoadable } from "@arcforge/kernel"
import { loadTool, type LoadedTool } from "./load"
import type { MediateOpts } from "./mediate"

type ToolsOpts = {
    mediation: MediateOpts
}

/**
 * Tools — the agent's own executable scope, loaded into its own process.
 *
 * This is the in-process replacement for the capsule's tool machinery: the
 * guest-side `Scope()` that loaded and wrapped modules, plus the host-side
 * `build/tools.ts` that sent `tool:load` and awaited a confirmation event.
 * Those were one operation split across a wire; here they are one function.
 *
 * ── What this deletes downstream ────────────────────────────────────────────
 *
 * `axon.tools.foo.bar()` from a script currently serialises its arguments into
 * a string, embeds them in synthesised TypeScript, ships that over JSONL, and
 * evals it in another process — because the capsule's only conversation is
 * `run(code)` and there is no per-function RPC. In one heap a tool call is a
 * function call, so that bridge (`runtime/source/tools.ts::callTool`) has
 * nothing left to do.
 *
 * The tool boundary is gone; the tool SCOPE is not. What the model is told it
 * can call stays a curated declaration derived from the blueprint
 * (kernel/src/scope.ts), never a reflection of whatever happens to be in the
 * process — otherwise the model would see `require`, `globalThis` and every
 * transitive dependency, and no editor `.d.ts` could ever be generated.
 */
export function Tools(opts: ToolsOpts) {
    const loaded = new Map<string, LoadedTool>()

    return {
        /**
         * Load every loadable tool the blueprint declares.
         *
         * SEQUENTIAL, and it throws on the first failure. Both match what the
         * capsule's build did: a capsule missing scope the agent was promised
         * is invalid state, and continuing past a broken tool leaves the model
         * holding a namespace that will fail at call time instead of at boot.
         *
         * `isLoadable` is the same predicate that produces the model's <scope>
         * and the editor's ambient declarations — what can run, what the model
         * is told it can call, and what an editor typechecks against are one
         * list by construction.
         */
        async install(tools: AxonTool[]): Promise<void> {
            for (const tool of tools.filter(isLoadable)) {
                loaded.set(tool.name, await loadTool(tool, opts.mediation))
            }
        },

        /** Drop one namespace — a hot reload removing a tool the author deleted. */
        remove(namespace: string): void {
            loaded.delete(namespace)
        },

        /** Drop everything, for a reload that rebuilds the whole set. */
        clear(): void {
            loaded.clear()
        },

        get namespaces(): string[] {
            return [...loaded.keys()]
        },

        /**
         * The globals model-emitted code and agent-authored code both execute
         * against.
         *
         * Every export lands under its OWN name — `export function add()` is
         * `add()`, `export const fs = {...}` is `fs.read()`. A tool's
         * `namespace` is the file it came from, kept for diagnostics; it is
         * never a prefix the caller addresses through. Same placement the
         * editor's generated declarations assume.
         */
        globals(): Record<string, unknown> {
            const globals: Record<string, unknown> = {}
            for (const tool of loaded.values()) Object.assign(globals, tool.values)
            return globals
        },
    }
}

export type ToolsT = ReturnType<typeof Tools>
