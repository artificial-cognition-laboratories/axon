import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonHandle } from "@arcforge/types"

const argsStorage = new AsyncLocalStorage<Record<string, unknown>>()

/**
 * Args for the one place ALS cannot reach: a dynamic `import()`'s module
 * evaluation.
 *
 * Scripts are invoked by importing them, and ALS context does NOT propagate
 * across that boundary in Bun — neither into the synchronous top-level body
 * nor after an `await` inside it, so `args` read at a script's top level saw
 * an empty object no matter what was passed.
 *
 * Keyed by RUN ID, not a single serialized slot. The slot version was a real
 * race: `withArgs` saved the previous value and restored it in a `finally`,
 * so two overlapping invocations interleaved on one variable — A sets, B sets,
 * A reads B's args. Reproduced deterministically (A in flight reading
 * `{who:"B"}`), and it surfaced as non-deterministic failures in
 * tests/integration/handle/scripts.test.ts the moment the suite ran with
 * --parallel. Nothing threw; a script simply ran against another call's args.
 *
 * The run ID is the cache-bust token the script specifier already carries
 * (see runtime/source/scripts.ts), so the script reads its args back through
 * `args` with no ambiguity about which invocation it belongs to, however many
 * are in flight.
 */
const runArgs = new Map<string, Record<string, unknown>>()

/**
 * Resolve the args for whichever run is asking.
 *
 * There is deliberately NO "current run" variable. Any single slot — however
 * carefully saved and restored — is a race the moment two invocations overlap,
 * which is exactly the bug this replaced. Instead the caller is identified from
 * the stack: a script's frames carry its own specifier, and that specifier
 * carries the run id (`...?run=<uuid>`), so each concurrent script resolves to
 * its own entry with nothing shared between them.
 *
 * Falls back to the sole in-flight run when the stack carries no run id. That
 * covers an `args` read from a helper the script imported (a separate module,
 * its own frames) while keeping the ambiguous case honest: with more than one
 * run in flight there is no defensible answer, so it yields `{}` rather than
 * guessing and handing a script another call's args.
 */
function argsForCaller(): Record<string, unknown> | undefined {
    const stack = new Error().stack ?? ""
    for (const [runId, args] of runArgs) {
        if (stack.includes(`run=${runId}`)) return args
    }
    return runArgs.size === 1 ? runArgs.values().next().value : undefined
}

/**
 * Owns every global mutation in the runtime. All globalThis writes live
 * here, nowhere else — this is the one place to audit for it.
 *
 * Two phases, same pattern as the old inject.ts:
 *   macros()  — noop globals, safe to import before the runtime exists.
 *               Any call throws INJECT_OUTSIDE_RUNTIME.
 *   runtime() — swaps in the live handle once Axon() has fully built it.
 *
 * `args` is scoped per-invocation: AsyncLocalStorage wherever context
 * propagates, and a run-id-keyed map for the dynamic-import window where it
 * does not (see runArgs above). Two concurrent script/tool calls each get
 * their own args regardless of interleaving.
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

        runtime(axon: AxonHandle, blueprint?: AxonBlueprint) {
            const g = globalThis as Record<string, unknown>

            g.axon = axon

            Object.defineProperty(g, "args", {
                configurable: true,
                get: () => argsStorage.getStore() ?? argsForCaller() ?? {},
            })

            installToolGlobals(g, axon, blueprint)
        },

        /**
         * Run fn with `args` scoped to this call only — safe under concurrency.
         *
         * `runId` must uniquely identify this invocation; callers importing a
         * script pass the same token they cache-bust the specifier with, so a
         * top-level read inside that module resolves to these args and no
         * other in-flight call's.
         */
        async withArgs<T>(runId: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
            runArgs.set(runId, args)
            try {
                return await argsStorage.run(args, fn)
            } finally {
                runArgs.delete(runId)
            }
        },
    }

    return inject
}

/** Tool globals installed by the last runtime() call, so a reinstall can retract them. */
let installedToolGlobals: string[] = []

/**
 * Tool exports as globals in host-side code — scripts, routes, hooks.
 *
 * A script author should not have to know a capsule subprocess exists. They
 * wrote `export function add()` in src/tools/; they should be able to call
 * `add(1, 2)`. That is the whole reason tools are globals in the agent's own
 * scope, and the same reasoning applies to the code the author writes around
 * the agent. `.agent/tool-globals.d.ts` has always declared them this way, so
 * until now an editor typechecked `kanban.list()` in a script while the runtime
 * threw "kanban is not defined".
 *
 * These are BINDINGS, not a second code path: each one delegates to the
 * matching axon.tools.* proxy, so mediation, policy, tracing and the capsule
 * round trip are byte-for-byte the calls that surface already makes. Nothing
 * here can drift from it, because there is nothing here to drift.
 *
 * Placement follows `flat`, exactly as the capsule installs it: the agent's own
 * src/tools/ exports land as top-level globals (`add`), a module's tools land
 * under their namespace (`github.openPr`).
 *
 * Binding is to the runtime that owns this process — one agent, one global
 * scope. A script driving a second instance addresses it explicitly through
 * that instance's own handle rather than through these globals, which is the
 * only unambiguous answer available while `globalThis` is process-wide.
 */
function installToolGlobals(g: Record<string, unknown>, axon: AxonHandle, blueprint?: AxonBlueprint): void {
    // A reload rebuilds the handle. Retract the previous set first so a tool
    // the author deleted does not linger as a callable global pointing at a
    // capsule namespace that no longer exists.
    for (const name of installedToolGlobals) delete g[name]
    installedToolGlobals = []

    const tools = axon.tools as Record<string, Record<string, unknown>> | undefined
    if (!tools) return

    for (const [namespace, members] of Object.entries(tools)) {
        if (!members || typeof members !== "object") continue

        const flat = (blueprint?.tools ?? []).find(tool => tool.name === namespace)?.flat === true
        if (!flat) {
            // Namespaced: one global per module, holding its members.
            define(g, namespace, members)
            continue
        }

        for (const [member, fn] of Object.entries(members)) define(g, member, fn)
    }
}

/**
 * Define one global without clobbering something that already owns the name.
 *
 * A tool called `fetch`, `console` or `process` must not silently replace the
 * host builtin that agent-authored code around it depends on — the tool stays
 * reachable through axon.tools.*, which is never ambiguous. Skipping is the
 * conservative half of a decision that is otherwise irreversible at runtime.
 */
function define(g: Record<string, unknown>, name: string, value: unknown): void {
    if (name in g && !installedToolGlobals.includes(name)) return
    g[name] = value
    installedToolGlobals.push(name)
}
