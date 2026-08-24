import { err } from "@arcforge/err"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import type { AxonHooksT } from "../platform"
import { ModuleContext } from "./context"
import type { LoadedModule } from "./load"

/**
 * One live module — the result of running a module's `setup()`. Holds the
 * disposers it registered via `ctx.onDispose()` so its live resources can be
 * released in reverse order on shutdown or reload.
 */
export type LiveModule = {
    name: string
    dispose: () => Promise<void>
}

/**
 * Run a single module's `setup(ctx)` and record the transaction to the session
 * log. Emits module:setup:start (with the config hash — the determinism
 * fingerprint) then :complete or :failed. A throwing setup fails loudly: the
 * caller aborts the whole boot rather than continue with a half-wired agent.
 *
 * Disposers registered during setup are captured here and returned as one
 * reverse-order teardown, wrapped in its own span bracket.
 */
export async function runSetup(opts: {
    loaded: LoadedModule
    blueprint: AxonBlueprint
    hooks: AxonHooksT
    session: AxonSessionT
}): Promise<LiveModule> {
    const { loaded, blueprint, hooks, session } = opts
    const { module, config, configHash, options } = loaded

    await session.commit("module:setup:start", { name: module.name, configHash, options })
    const started = Date.now()

    const disposers: Array<() => void | Promise<void>> = []
    const axon = ModuleContext({ blueprint, hooks, onDispose: fn => disposers.push(fn) })

    // A module with no setup() is legal — it contributes tools/prompts
    // statically and needs no boot-time wiring.
    if (config.setup) {
        try {
            // options was validated against module.optionsSchema in loadModule
            // — it satisfies the module's typed option shape. The generic is
            // erased on ModuleConfig here, so the runtime-validated bag is the
            // honest input to the typed setup at this one seam.
            await config.setup({ axon, options: options as Parameters<NonNullable<typeof config.setup>>[0]["options"] })
        } catch (cause) {
            const failure = err("MODULE_SETUP_FAILED", {
                detail: `${module.name} — ${cause instanceof Error ? cause.message : String(cause)}`,
                context: { name: module.name },
                cause,
            })
            await session.commit("module:setup:failed", { name: module.name, error: failure, durationMs: Date.now() - started })
            throw failure
        }
    }

    await session.commit("module:setup:complete", { name: module.name, durationMs: Date.now() - started })

    return {
        name: module.name,
        dispose: async () => {
            const disposeStarted = Date.now()
            await session.commit("module:dispose:start", { name: module.name })
            // Reverse registration order within the module — later-acquired
            // resources release before the earlier ones they may depend on.
            const failures: unknown[] = []
            for (const fn of [...disposers].reverse()) {
                try {
                    await fn()
                } catch (cause) {
                    failures.push(cause)
                }
            }
            if (failures.length > 0) {
                const failure = err("MODULE_SETUP_FAILED", {
                    detail: `${module.name} dispose failed`,
                    context: { name: module.name },
                    cause: new AggregateError(failures),
                })
                await session.commit("module:dispose:failed", { name: module.name, error: failure, durationMs: Date.now() - disposeStarted })
                throw failure
            }
            await session.commit("module:dispose:complete", { name: module.name, durationMs: Date.now() - disposeStarted })
        },
    }
}
