import { AxonBlueprint, Conform, type Conformed } from "@arcforge/core"
import type { AxonCloudClient } from "@arcforge/cloud"
import type { ProviderEntry } from "@arcforge/types"
import { Blueprint } from "../blueprint"

/**
 * Conformance — an agent's uses, each filled as its boot would fill it and
 * held to its interface's cases. What `axon conform` asks.
 *
 * Read from the agent as prepared: its compiled brain says what it uses and
 * where each interface's cases are, its config what it grants. Run in this
 * process, never inside the agent's box — it calls providers, it does not run
 * the agent.
 */
export function Conformance(opts: { cloud: AxonCloudClient; profileProviders(): Promise<readonly ProviderEntry[] | undefined> }) {
    return {
        async check(root: string): Promise<Conformed[]> {
            const profileProviders = await opts.profileProviders()
            const { blueprint } = await Blueprint({ root: root }).load({ ...(profileProviders ? { profileProviders: [...profileProviders] } : {}) })
            return Conform({ blueprint: AxonBlueprint(blueprint), cloud: opts.cloud }).run()
        },
    }
}

export type ConformanceT = ReturnType<typeof Conformance>
