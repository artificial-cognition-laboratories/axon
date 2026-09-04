import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"
import { defineArgs, defineAxonPlugin, defineMiddleware, defineModule, defineProps, definePrompt } from "@arcforge/types"
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

            /**
             * The AUTHORING globals a config file calls at module scope.
             *
             * `module.config.ts` starts with `export default defineModule({…})`,
             * so importing one needs `defineModule` to already exist. The
             * platform's blueprint scanner installs these during the build —
             * which is fine while the build and the runtime share a process,
             * and wrong the moment they do not: a confined agent imports its
             * modules in its OWN process, where nothing had installed them, and
             * boot died with "defineModule is not defined".
             *
             * Installed here because this is the one place that owns globalThis
             * writes, and `??=` so the scanner's copies win where both run —
             * they are the same identity functions either way.
             */
            g.defineModule ??= defineModule
            g.definePrompt ??= definePrompt
            g.defineArgs ??= defineArgs
            g.defineProps ??= defineProps
            g.defineMiddleware ??= defineMiddleware
            g.defineAxonPlugin ??= defineAxonPlugin

            g.axon = new Proxy({}, {
                get: outsideRuntime,
            })

            Object.defineProperty(g, "args", {
                configurable: true,
                get: outsideRuntime,
            })
        },

        /**
         * `loaded` is a THUNK returning the live tool scope, not a value: a
         * hot reload rebuilds that scope, and a captured map would keep
         * serving the tool the author just deleted.
         */
        runtime(axon: AxonHandle, blueprint?: AxonBlueprint, loaded?: () => Record<string, unknown>) {
            const g = globalThis as Record<string, unknown>

            /**
             * `globalThis.axon` serves TWO audiences that used to live in
             * different processes.
             *
             * Script-land sees the AxonHandle — `axon.request()`,
             * `axon.tools.*`, the curated surface agent-authored code is
             * written against. TOOL code sees the capsule's ambient, whose
             * only member is `activity()`: write-only telemetry that grants
             * nothing, which a tool calls as `globalThis.axon?.activity(...)`.
             *
             * Two objects, one name, and it never mattered while the capsule
             * had its own global object. In one heap whichever installs last
             * wins — and the runtime installs after the capsule, so every tool
             * calling `activity()` hit "not a function" on a handle that had
             * no such member.
             *
             * Merged rather than ordered: an install order that happens to
             * work is not a contract, and a tool has no way to reach a
             * different global. The ambient's members are carried forward, so
             * both audiences find what they were promised on the one name they
             * both use.
             */
            const ambient = g.axon as { activity?: unknown } | undefined
            g.axon = ambient?.activity
                // A PROXY, not a spread: the handle exposes `tools` and
                // `ready` as GETTERS that a reload replaces, and copying them
                // would freeze both at their boot values — a script would keep
                // calling the tool map from before the author's edit. Every
                // miss forwards to the live handle; `activity` is the one own
                // member.
                ? new Proxy(axon as object, {
                    get: (target, key, receiver) => key === "activity"
                        ? ambient.activity
                        : Reflect.get(target, key, target),
                    has: (target, key) => key === "activity" || Reflect.has(target, key),
                }) as AxonHandle
                : axon

            Object.defineProperty(g, "args", {
                configurable: true,
                get: () => argsStorage.getStore() ?? argsForCaller() ?? {},
            })

            installToolGlobals(g, loaded?.() ?? {})
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
 * Tool exports as globals — the agent's whole scope, in one heap.
 *
 * Placement follows ORIGIN, and `Tools.globals()` has already applied it:
 * the agent's own `src/tools/*.ts` and the shared workspace's are flat
 * (`export function add()` is `add()`), a MODULE's live under the module's
 * name (`github.openPr()`). This installer only writes what it is handed.
 *
 * ONE INSTALLER, ONE SOURCE. These come from the loaded tool scope — the
 * same `Tools.globals()` the model's own code executes against — so
 * script-land, prompts, routes, hooks and model-emitted code cannot see
 * different shapes of the same tool. A second installer here once projected
 * `axon.tools.<file>.<export>` off the flat map, which double-wrapped a
 * module exporting one object (`fs` became `{ fs: {...} }`) and silently
 * clobbered the correct binding. That projection is not coming back: the
 * namespaced surface is built by `Tools.namespaced()` from the loaded set's
 * own namespaces, never re-derived from the flat globals.
 *
 * The values are ALREADY MEDIATED — the loader wraps every export before it
 * reaches this scope — so policy, tracing and escalation are enforced by
 * calling them, not by any wrapping done here.
 *
 * Binding is to the runtime that owns this process — one agent, one global
 * scope. Cross-agent tool calls are deliberately not a thing: a second
 * agent is a second process, and a global that could mean either agent's
 * tool is a footgun rather than a feature.
 */
function installToolGlobals(g: Record<string, unknown>, loaded: Record<string, unknown>): void {
    // A reload rebuilds the scope. Retract the previous set first so a tool
    // the author deleted does not linger as a callable global.
    for (const name of installedToolGlobals) delete g[name]
    installedToolGlobals = []

    for (const [name, value] of Object.entries(loaded)) {
        // Tool vs tool is fatal: two files exporting the same name give the
        // author no way to say which they meant, and last-one-wins picks
        // silently.
        if (installedToolGlobals.includes(name)) {
            throw err("TOOL_GLOBAL_COLLISION", { context: { name } })
        }

        // Tool vs anything that ALREADY owns the name — a host builtin like
        // `fetch`, or the runtime's own `axon`/`args` — is not a collision to
        // resolve, it is a name that is taken. The tool does not get it.
        //
        // Silently replacing `fetch` breaks every piece of agent-authored code
        // around the tool that relies on the real one, and it fails nowhere
        // near the cause. Overwriting `axon` or `args` is worse: it removes
        // the runtime handle the rest of the scope is written against.
        //
        // Skipping is not a silent failure, because nothing is lost — the tool
        // stays fully reachable through `axon.tools.<namespace>.<fn>()`, which
        // is exactly the case that surface exists for. The flat global is a
        // convenience; the namespaced one is the guarantee.
        if (name in g) continue

        g[name] = value
        installedToolGlobals.push(name)
    }
}

