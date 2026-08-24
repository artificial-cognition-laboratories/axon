import type { EngineCapability } from "@arcforge/types"
import type { AxonProvider } from "./provider"

/** One source that could not answer, and why. */
export type CatalogueFailure = {
    provider: string
    message: string
}

/**
 * Everything the user's declared providers can supply, plus every source
 * that failed to say.
 *
 * Failures are DATA, never a shorter list. A dead Ollama daemon and a user
 * who owns no local models produce identical catalogues, and only this field
 * tells them apart — without it, an agent silently falls back to the cloud
 * for a role its user intended to run on their own machine, which is a
 * billing surprise and a privacy one.
 */
export type Catalogue = {
    capabilities: EngineCapability[]
    failures: CatalogueFailure[]
}

/**
 * Ask every provider what it can supply, concurrently.
 *
 * One slow or unreachable source must not delay the rest, so these run in
 * parallel and settle independently. Order is preserved from the pool, which
 * is the user's declared preference — the resolver's ranking only ever
 * breaks ties among candidates that all satisfy a requirement, so this order
 * decides nothing that correctness depends on.
 */
export async function gather(providers: readonly AxonProvider[]): Promise<Catalogue> {
    const settled = await Promise.allSettled(providers.map(provider => provider.catalogue()))

    const capabilities: EngineCapability[] = []
    const failures: CatalogueFailure[] = []

    settled.forEach((result, index) => {
        const provider = providers[index]
        if (!provider) return

        if (result.status === "fulfilled") {
            capabilities.push(...result.value)
            return
        }

        failures.push({
            provider: provider.name,
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
    })

    return { capabilities, failures }
}
