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
 * parallel and settle independently. Results are collected in POOL ORDER
 * rather than completion order — a provider that answered slowly must not
 * outrank one the user listed first.
 *
 * That order is the user's declared preference and it is load-bearing: one
 * model is reachable through several routes, those routes are identical on
 * every ranking axis, and which one wins decides who pays for the call. The
 * resolver settles it explicitly from the pool order rather than inheriting
 * whatever this array happened to look like — see `preference()`.
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
