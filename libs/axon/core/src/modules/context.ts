import type { AxonBlueprint, ModuleSetupAxon } from "@arcforge/types"
import { err } from "@arcforge/err"
import type { AxonHooksT } from "../platform"

/**
 * The narrow `axon` handle a module's `setup()` receives. Deliberately
 * smaller than the full AxonHandle: a module registers boot-time wiring
 * (hooks, policy) — it does not run conversations. Everything here is a thin
 * projection over pieces Axon() already built; the context owns no state.
 *
 * `server` and `tools` are declared by the type but throw loudly: no module
 * consumes them yet, and wiring dynamic routes from setup() means teaching
 * AxonServer about a second, runtime route source — a boundary decision to
 * make when a real module needs it, not a silent stub that returns nothing.
 */
export function ModuleContext(opts: {
    blueprint: AxonBlueprint
    hooks: AxonHooksT
    /** Sink for teardown callbacks registered via ctx.onDispose(). Owned by the caller (runSetup), which runs them in reverse. */
    onDispose: (fn: () => void | Promise<void>) => void
}): ModuleSetupAxon {
    const { blueprint, hooks } = opts

    // The narrow module handle intentionally exposes hooks with a loose
    // (string, ...any[]) signature — a module registers against hook names by
    // string, not against the runtime's internal typed AxonHooks map. Bridge
    // the two at this one seam.
    const hook: ModuleSetupAxon["hook"] = hooks.hook as ModuleSetupAxon["hook"]
    const callHook: ModuleSetupAxon["callHook"] = hooks.callHook as ModuleSetupAxon["callHook"]

    return {
        hook,
        callHook,
        onDispose: opts.onDispose,

        env: {
            get: key => blueprint.env[key],
            require: key => {
                const value = blueprint.env[key]
                if (value === undefined || value === "") {
                    throw err("MODULE_ENV_REQUIRED", { detail: `module setup requires env var "${key}"`, context: { key } })
                }
                return value
            },
        },

        policy: {
            // Modules declare policy needs statically (ModulePolicyNeeds); the
            // CLI reconciles them at install. Runtime mutation of the resolved
            // policy from setup() is not a capability we grant — the resolved
            // agent policy is authoritative and immutable at boot.
            update: () => {
                throw err("MODULE_POLICY_IMMUTABLE", {
                    detail: "policy.update() from setup() — declare policy needs statically in module.config.ts",
                })
            },
        },

        server: {
            addRoute: () => {
                throw err("MODULE_SERVER_NOT_WIRED", { detail: "ctx.server.addRoute — declare routes as server/api/ files in the module" })
            },
            addMiddleware: () => {
                throw err("MODULE_SERVER_NOT_WIRED", { detail: "ctx.server.addMiddleware — not wired" })
            },
        },

        tools: {
            get: () => {
                throw err("MODULE_SERVER_NOT_WIRED", { detail: "ctx.tools.get — not wired" })
            },
        },
    }
}
