import type { AxonBlueprint } from "@arcforge/types"

/**
 * The scope a `.vue` / `.prompt` template renders in. Agent-authored
 * templates are treated with the same scope as the rest of the agent's
 * code — `axon` (the live runtime handle) and `process.env` (the agent's
 * resolved environment) are both in scope, exactly as they are in a tool
 * or script.
 *
 * `process` is a minimal shim, not the host's global: only `env` is
 * exposed, sourced from blueprint.env — the CLI-resolved environment.
 * The runtime never reads the host's real process.env (see blueprint.ts);
 * a template reaching `process.env.NAME` reads the agent's own .env, not
 * whatever happens to be in the TUI process's shell.
 *
 * `axon` is read lazily off globalThis: the runtime handle is wired after
 * the constructs that render templates exist, so it can't be captured by
 * reference — by the time a template actually renders, inject.runtime()
 * has fired and the global is live.
 */
export function promptContext(blueprint: AxonBlueprint): Record<string, unknown> {
    return {
        axon: (globalThis as { axon?: unknown }).axon,
        process: { env: blueprint.env },
    }
}
