import type { AxonTool, AxonToolNamespaces } from "@arcforge/types"
import { err } from "@arcforge/err"

/** One mediated tool export. Every call crosses policy, so all of them are async. */
type ToolFn = (...args: never[]) => Promise<unknown>
import { isLoadable } from "@arcforge/kernel"
import { loadTool, type LoadedTool } from "./load"
import type { MediateOpts } from "./mediate"

type ToolsOpts = {
    mediation: MediateOpts
    /**
     * Where bundled tool source is materialized so it can be imported — the
     * agent's own frame cache, never the OS temp directory. See
     * `@arcforge/capsule/materialize` for why that distinction is load-bearing.
     */
    scratch: string
    /**
     * Two tools exporting the same name into one scope.
     *
     * Reported rather than resolved: which one the author meant is not
     * something the runtime can know, and quietly renaming one — which is what
     * wrapping a module's tools under their own name amounted to — changes how
     * it is called for a reason the author never chose.
     *
     * Optional because the placement is correct either way; this only decides
     * whether anyone is told. A surface that can warn supplies one.
     */
    onClash?(input: { name: string; previous: string; next: string }): void
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
    /** Origin per loaded namespace — decides flat vs namespaced placement. */
    const origins = new Map<string, AxonTool["origin"]>()

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
                loaded.set(tool.name, await loadTool(tool, opts.mediation, opts.scratch))
                origins.set(tool.name, tool.origin)
            }
        },

        /**
         * Rebuild the whole set for a hot reload.
         *
         * Replaces rather than merges, so a tool the author DELETED actually
         * goes away. Without this the set was built once at boot and never
         * again: `install()` was called from Axon() alone, so after an
         * `update()` the handle re-projected `axon.tools` and reinstalled the
         * globals off a map that could no longer change. A deleted tool stayed
         * callable until restart and an added one was never reachable.
         *
         * Loads into a SCRATCH map before touching the live one — a reload
         * whose new set fails to load leaves the previous scope intact rather
         * than a half-installed one, the same reason install() throws on the
         * first failure instead of continuing.
         */
        async reload(tools: AxonTool[]): Promise<void> {
            const next = new Map<string, LoadedTool>()
            const nextOrigins = new Map<string, AxonTool["origin"]>()
            for (const tool of tools.filter(isLoadable)) {
                next.set(tool.name, await loadTool(tool, opts.mediation, opts.scratch))
                nextOrigins.set(tool.name, tool.origin)
            }
            loaded.clear()
            origins.clear()
            for (const [name, tool] of next) loaded.set(name, tool)
            for (const [name, origin] of nextOrigins) origins.set(name, origin)
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
            /** Which tool placed each name, so a clash can name both sides. */
            const placedBy = new Map<string, string>()

            for (const tool of loaded.values()) {
                /**
                 * EVERY tool is placed flat, whatever its origin.
                 *
                 * Placement used to follow origin: an agent's own tools flat,
                 * an installed module's wrapped under its own name. Two things
                 * were wrong with that.
                 *
                 * It DISAGREED WITH THE DECLARATIONS in practice. The generated
                 * `.d.ts` and the model's `<scope>` both spelled a module tool
                 * `subagents.subagents.request()`, and the runtime here did not
                 * always agree — so a model read its own types, called exactly
                 * what they promised, and got `undefined is not an object`.
                 * That is the one failure this whole surface exists to prevent.
                 *
                 * And it made placement CONDITIONAL on provenance, which is not
                 * the author's concern. `import { subagents }` should be
                 * `subagents.request()` whether that came from src/tools or a
                 * package — otherwise moving a tool into a module silently
                 * rewrites every call site, for a reason nobody chose.
                 *
                 * A module exporting `const fs = {…}` is already its own
                 * namespace; it needs no help being one. What the wrap actually
                 * guarded was a NAME CLASH between two tools, and that is the
                 * author's to resolve — so it is reported rather than silently
                 * worked around by changing how one of them is addressed.
                 */
                for (const [name, value] of Object.entries(tool.values)) {
                    const previous = placedBy.get(name)
                    if (previous !== undefined && previous !== tool.namespace) {
                        /**
                         * Last write wins, and SAYS SO.
                         *
                         * Refusing would brick an agent over a collision it can
                         * still mostly serve, and silence is how the previous
                         * behaviour hid: `Object.assign` overwrote and nothing
                         * anywhere recorded that a capability had been shadowed.
                         */
                        opts.onClash?.({ name, previous, next: tool.namespace })
                    }
                    globals[name] = value
                    placedBy.set(name, tool.namespace)
                }
            }
            return globals
        },

        /**
         * The NAMESPACED view — `axon.tools.<namespace>.<fn>()`.
         *
         * The escape hatch, deliberately not the primary path. Model-emitted
         * code calls tools flat, as the <scope> block and the .d.ts describe
         * them; this exists for the cases where a bare name is unavailable or
         * ambiguous, and it is always unambiguous:
         *
         *   - a tool named after a host builtin. `installToolGlobals` refuses
         *     to clobber `fetch`, so the tool is only reachable here.
         *   - host-side code (a route, a hook, `<script setup>`) that wants to
         *     name the tool it means rather than rely on the flat scope.
         *
         * Built fresh from the live map on every call, never captured: a hot
         * reload replaces the set, and a snapshot would keep serving a deleted
         * tool. The values are the SAME mediated functions the globals expose —
         * one loader, one wrapper — so policy, tracing and escalation cannot
         * drift between the two surfaces.
         */
        namespaced(declared: AxonTool[] = []): AxonToolNamespaces {
            const tools: Record<string, Record<string, ToolFn>> = {}

            // DECLARED first, so a namespace the blueprint promises is present
            // even when nothing loaded it — `isLoadable` is false for a tool
            // with neither source nor entry path, so install() skips it while
            // the model's <scope> block still lists it.
            //
            // Present, but every member THROWS. Absent, the call dies as
            // "cannot read property of undefined" pointing at the caller;
            // silently no-op'd, it would report success for work that never
            // happened. Neither says the true thing, which is that the agent
            // was promised a function nothing supplies.
            for (const tool of declared) {
                if (loaded.has(tool.name)) continue
                // ASYNC, like every mediated tool call. A synchronous throw here
                // would reach a caller as a raw exception where the same call
                // on a loaded tool rejects, so `await tool.fn()` in a try/catch
                // would behave differently depending on whether the tool exists.
                tools[tool.name] = Object.fromEntries(tool.fns.map(fn => [fn.name, async () => {
                    throw err("CAPSULE_TOOL_FAILED", {
                        detail: `${tool.name}.${fn.name} is not defined — "${tool.name}" is declared in blueprint.tools but was never loaded (no source, no entry path)`,
                        context: { namespace: tool.name, fn: fn.name },
                    })
                }]))
            }

            // Every value here came from `mediate()`, which returns an async
            // wrapper — the cast states what the loader already guarantees
            // rather than widening the public contract to `unknown`.
            for (const tool of loaded.values()) tools[tool.namespace] = tool.values as Record<string, ToolFn>
            return tools as AxonToolNamespaces
        },
    }
}

export type ToolsT = ReturnType<typeof Tools>
