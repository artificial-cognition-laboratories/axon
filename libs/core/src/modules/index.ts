import type { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "../kernel/session"
import type { AxonHooksT } from "../platform/hooks"
import { loadModule } from "./load"
import { runSetup, type LiveModule } from "./setup"

/**
 * Modules — the boot-time executor for the agent's declared modules.
 *
 * For each module in the blueprint (in blueprint order — the flattened,
 * declaration-ordered list the scanner produced), imports its module.config.ts
 * by the statically-resolved `configPath`, validates options, and runs
 * `setup(ctx)` against a narrow `axon` handle. Setup is SEQUENTIAL and total:
 * a failure aborts the whole boot, so the only outcomes are "every module
 * wired in order" or "boot failed at module K" — never a half-wired agent.
 *
 * The handle is a manager (Coding Standards): it owns the live module set as
 * swappable `current` state. `reload()` disposes the current set in reverse
 * order, then re-runs setup for the new blueprint — reload is exactly
 * shutdown+boot, so a reloaded agent is identical to a freshly-booted one.
 *
 * Determinism: same blueprint (same modules, order, options, config bytes) ⇒
 * same setup sequence ⇒ same wired state, or failure at the same point. The
 * session log (module:setup:* / module:dispose:*) is the replayable proof.
 */
export async function Modules(opts: {
    blueprint: AxonBlueprint
    hooks: AxonHooksT
    session: AxonSessionT
}): Promise<ModulesT> {
    const { hooks, session } = opts

    let live: LiveModule[] = await setupAll(opts.blueprint)

    async function setupAll(blueprint: AxonBlueprint): Promise<LiveModule[]> {
        const result: LiveModule[] = []
        // Sequential, blueprint order — the deterministic contract.
        for (const module of blueprint.modules) {
            const loaded = await loadModule(module)
            result.push(await runSetup({ loaded, blueprint, hooks, session }))
        }
        return result
    }

    async function disposeAll(): Promise<void> {
        // Reverse module order — a module tears down before the ones declared
        // before it, which it may depend on. Errors are isolated per module.
        const failures: unknown[] = []
        for (const module of [...live].reverse()) {
            try {
                await module.dispose()
            } catch (cause) {
                failures.push(cause)
            }
        }
        live = []
        if (failures.length > 0) throw new AggregateError(failures, "module teardown completed with failures")
    }

    return {
        get current() {
            return live
        },

        /**
         * Set up modules for a blueprint. Used on reload AFTER dispose() and
         * the server rebuild, because AxonServer resets all hooks — a module's
         * setup() hooks must re-register after that reset to survive. Boot
         * calls setupAll directly; reload splits dispose/setup around the
         * server rebuild, which is why these are two methods, not one reload().
         */
        async setup(blueprint: AxonBlueprint) {
            live = await setupAll(blueprint)
        },

        /** Teardown: dispose every module in reverse order. Empties the live set. */
        async dispose() {
            await disposeAll()
        },
    }
}

export type ModulesT = {
    readonly current: LiveModule[]
    setup(blueprint: AxonBlueprint): Promise<void>
    dispose(): Promise<void>
}
