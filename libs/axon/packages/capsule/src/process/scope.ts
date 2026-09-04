import { capsuleFault } from "./fault"
import { materializeTool } from "./materialize"
import type { CapsuleCommand } from "../../types"
import type { ExecutionT } from "./execution"
import type { MediatorT } from "./mediator"
import type { InProcWireT as SandboxWireT } from "../inproc/emitter"

type ScopeOpts = {
    /** Subscribe to a command wire. False in-process — see Runner.dispatch. */
    dispatch?: boolean
    mediator: MediatorT
    wire: SandboxWireT
    /** Correlates each fn span to the command that made the call. */
    execution: ExecutionT
    /**
     * Where bundled tool source is written so it can be imported — the
     * agent's own frame cache, never the OS temp directory. Passed in rather
     * than derived here: this leaf knows how to load a tool, not where the
     * agent lives. See ./materialize for why the distinction matters.
     */
    scratch: string
}

/** A tool module's shape once loaded: name + the functions it exports. */
type LoadedTool = {
    namespace: string
    values: Record<string, unknown>
}

/**
 * Scope — the globals cmd:run code executes against. Loads each configured
 * CapsuleTool either under its namespace or as flat named exports, recursively
 * wrapping callable values so every call is mediated first. This is the actual
 * enforcement point; nothing in run() has a path to an unwrapped function.
 */
export function Scope(opts: ScopeOpts) {
    /**
     * This scope's identity, used to cache-bust tool imports.
     *
     * One per Scope, minted at construction: tools loaded into the SAME scope
     * share a module instance (state persists across submissions), and two
     * scopes never do (a fresh capsule gets fresh tools).
     */
    const instanceId = crypto.randomUUID()
    const { mediator, wire, execution } = opts
    const namespaces = new Map<string, LoadedTool>()

    function wrapValue(value: unknown, path: string, owner: string, receiver?: object): unknown {
        if (typeof value === "function") {
            return async (...args: unknown[]) => {
                const subject = typeof args[0] === "string" ? args[0] : ""
                const allowed = await mediator.check(path, subject, args, owner)
                if (!allowed) throw new Error(`CAPSULE_POLICY_DENIED: ${path} denied by policy`)

                // The tool-call span. Opened only AFTER policy admits the
                // call: a denied call is a policy fact (capsule:policy:denied),
                // not an execution that failed, and pairing a :start with no
                // matching end would leave a permanently-open bracket in
                // every flame graph.
                const commandId = execution.current?.id ?? ""
                const started = Date.now()
                wire.emit("process:fn:start", { commandId, module: owner, fn: path, args })
                try {
                    const result = await Reflect.apply(value, receiver, args)
                    wire.emit("process:fn:complete", { commandId, module: owner, fn: path, result, durationMs: Date.now() - started })
                    return result
                } catch (cause) {
                    wire.emit("process:fn:failed", {
                        commandId,
                        module: owner,
                        fn: path,
                        error: capsuleFault("CAPSULE_FN_FAILED", {
                            message: cause instanceof Error ? cause.message : String(cause),
                            context: { fn: path, module: owner },
                            cause,
                        }),
                        durationMs: Date.now() - started,
                    })
                    throw cause
                }
            }
        }

        if (value !== null && typeof value === "object") {
            return new Proxy(value, {
                get(target, key) {
                    const child = Reflect.get(target, key, target)
                    return typeof key === "string" ? wrapValue(child, `${path}.${key}`, owner, target) : child
                },
            })
        }

        return value
    }

    async function loadTool(tool: Extract<CapsuleCommand, { type: "tool:load" }>): Promise<void> {
        const started = Date.now()
        wire.emit("process:tool:load:start", { namespace: tool.namespace })
        try {
            /**
             * Each capsule gets its OWN module instance for every tool.
             *
             * A tool's module scope is its resident state — the counter that
             * increments across submissions, the client it opened once. Each
             * subprocess had a fresh registry, so that state began empty per
             * capsule for free.
             *
             * One heap has one registry keyed by specifier, so a second
             * capsule loading the same tool got the FIRST one's module, state
             * and all: a counter that should start at zero began wherever the
             * previous capsule left it. Cache-busting the specifier restores
             * the isolation the process boundary used to provide.
             *
             * The instance id is per-Scope, so reloading a tool within one
             * capsule still shares state — which is the contract "state
             * persists across run() calls" depends on.
             */
            const specifier = "path" in tool ? tool.path : await materializeTool(opts.scratch, tool.source)
            const mod = await import(`${specifier}?capsule=${instanceId}`)

            const fallback = mod.default as { exports?: Record<string, unknown> } | undefined
            const named = Object.fromEntries(Object.entries(mod).filter(([name]) => name !== "default"))
            const exported = Object.keys(named).length > 0 ? named : (fallback?.exports ?? {})
            const values: Record<string, unknown> = {}
            for (const [name, value] of Object.entries(exported)) {
                // `<namespace>.<export>` — the POLICY key, not the call path.
                //
                // Deliberately still namespaced although the global is flat:
                // a policy rule is written against a tool the user installed
                // (`fs.read`, `github.openPr`), and flattening this would
                // make every rule match on a bare export name, so two
                // modules exporting `read` would share one permission. The
                // caller says `read(...)`; the mediator still asks about
                // `fs.read`.
                const path = `${tool.namespace}.${name}`
                values[name] = wrapValue(value, path, tool.namespace)
            }

            namespaces.set(tool.namespace, { namespace: tool.namespace, values })
            wire.emit("process:tool:load:complete", { namespace: tool.namespace, fns: Object.keys(values), durationMs: Date.now() - started })
        } catch (cause) {
            wire.emit("process:tool:load:failed", {
                namespace: tool.namespace,
                error: capsuleFault("CAPSULE_TOOL_FAILED", {
                    message: cause instanceof Error ? cause.message : String(cause),
                    context: { namespace: tool.namespace },
                    cause,
                }),
                durationMs: Date.now() - started,
            })
        }
    }

    // Same split as Runner: subprocess-side, tool loads arrive over the wire;
    // in-process the manager calls `load`/`unload` directly.
    if (opts.dispatch !== false) {
        wire.onCommand((cmd: CapsuleCommand) => {
            if (cmd.type === "tool:load") {
                void loadTool(cmd)
            } else if (cmd.type === "tool:unload") {
                namespaces.delete(cmd.namespace)
                wire.emit("process:tool:unloaded", { namespace: cmd.namespace })
            }
        })
    }

    return {
        /** Load one tool into scope. Throws nothing — failure is an event, as it always was. */
        load: loadTool,

        /**
         * What a namespace actually exported, or undefined if it never loaded.
         *
         * The boot handshake compares this against what the tool DECLARED. The
         * subprocess reported it over the wire as `tool:load:complete.fns`;
         * here the caller can simply read it.
         */
        exportsOf(namespace: string): Record<string, unknown> | undefined {
            return namespaces.get(namespace)?.values
        },

        /** Drop a namespace — a hot reload removing a tool the author deleted. */
        unload(namespace: string): void {
            namespaces.delete(namespace)
            wire.emit("process:tool:unloaded", { namespace })
        },

        /**
         * The globals object cmd:run executes with.
         *
         * Every export lands under its OWN name — the tool's `namespace` is
         * the file it came from, used for diagnostics, never a prefix the
         * caller addresses through.
         */
        globals(): Record<string, unknown> {
            const globals: Record<string, unknown> = {}
            for (const tool of namespaces.values()) Object.assign(globals, tool.values)
            return globals
        },
    }
}

export type ScopeT = ReturnType<typeof Scope>
