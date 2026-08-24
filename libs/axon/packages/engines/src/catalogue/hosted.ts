import type { AxonEngineDriver, EngineCapability, EngineCloud } from "@arcforge/types"
import { fromModalityString } from "./modalities"
import type { AxonProvider } from "./provider"

type HostedOpts = {
    /** Route name — which `via` in the registry's routes this provider serves. */
    name: string
    cloud: EngineCloud
    /** Build the transport for one resolved model. */
    driver(model: string): AxonEngineDriver
    /** Concurrency ceiling the user put on this provider, if any. */
    slots?: number
}

/**
 * Every hosted route reads the same catalogue and differs only in which
 * `via` it claims and how it talks to the wire — so the shape is written
 * once here and each provider supplies its own name and driver.
 *
 * Hosted routes are CONNECTIONS, not resources: nothing is loaded, nothing
 * occupies memory, and `create()` is a closure over a model id. That is the
 * whole reason local weights need a resource manager and these do not.
 */
export function HostedProvider(opts: HostedOpts): AxonProvider {
    async function capabilities(): Promise<EngineCapability[]> {
        const catalogue = await opts.cloud.registry.models.all()
        const supplied: EngineCapability[] = []

        for (const model of catalogue.models) {
            const route = model.routes.find(candidate => candidate.via === opts.name)
            if (!route) continue

            // A model whose modality string cannot be read is left out
            // entirely. Defaulting it to text→text would let a role bind to
            // something that fails at the first call, which is the one
            // failure this layer exists to move to prepare time.
            const shape = fromModalityString(model.modality)
            if (!shape) continue

            supplied.push({
                id: route.model,
                provider: opts.name,
                name: model.name,
                type: shape.type,
                in: shape.in,
                out: shape.out,
                ...(model.context > 0 ? { context: model.context } : {}),
                // Hosted routes reach a frontier model behind an API that
                // enforces a reply schema. Local weights get no such
                // assumption — see the ollama provider.
                structured: true,
                local: false,
                ...(opts.slots !== undefined ? { slots: opts.slots } : {}),
            })
        }

        return supplied
    }

    return {
        name: opts.name,

        /**
         * Set when the catalogue this provider read was served from disk.
         * Read by the boot trace to report whether inference paid for the
         * wire — see `axon:inference:provider`.
         */
        get cachedAt() {
            return opts.cloud.registry.models.wasCached?.() ? Date.now() : undefined
        },

        catalogue: capabilities,

        async resolve(ref: string): Promise<EngineCapability | null> {
            const supplied = await capabilities()
            return supplied.find(capability => capability.id === ref) ?? null
        },

        create(capability: EngineCapability): AxonEngineDriver {
            return opts.driver(capability.id)
        },
    }
}
