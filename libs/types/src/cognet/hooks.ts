import type { CognetWake } from "../kernel/abi"

/**
 * Cognet lifecycle hooks — the call points the host awaits at fixed moments
 * of a brain's life. Mirrors AxonHooks in shape and discipline but is a
 * COMPLETELY SEPARATE surface: Axon's hooks are the runtime/server's
 * lifecycle; these are the cognet's own, one ring down.
 *
 * Distinct from cognet:* telemetry (fire-and-forget bus narration) and from
 * the world (domain facts): these are in-order, awaited-to-completion
 * plumbing points. Registered via `definePlugin(({ hooks }) => ...)` in
 * plugins/*.ts, fired by the host — never by the loop, never by kernel code.
 *
 * PLUMBING ONLY. Load/save derived state, warm caches, attach devtools.
 * A domain fact ("user arrived", "tool finished") is a stimulus that folds
 * into the world, NEVER a hook — the moment cognition leaks into a hook,
 * the loop stops being the one place a brain's behavior is legible.
 */
export type CognetHooks = {
    /** Kernel bound, main() has run, loop declared — the brain is ready but not yet woken. */
    "boot": () => void | Promise<void>

    /** A wake is about to run. Receives the wake it brackets. */
    "wake": (wake: CognetWake) => void | Promise<void>

    /** One tick of a wake is about to run. Hot path — keep handlers cheap. */
    "tick": (info: { tick: number }) => void | Promise<void>

    /** Brain off. Release derived state; durable writes already happened at commit time. */
    "shutdown": () => void | Promise<void>
}

export type CognetHookName = keyof CognetHooks

/** The surface a plugin registers against. */
export type CognetPluginContext = {
    hooks: {
        on<N extends CognetHookName>(name: N, fn: CognetHooks[N]): () => void
    }
}

/** A cognet plugin — plumbing wired to lifecycle hooks. What definePlugin() produces. */
export type CognetPlugin = (ctx: CognetPluginContext) => void
