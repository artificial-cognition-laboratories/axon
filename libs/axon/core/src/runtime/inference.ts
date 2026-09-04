import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonEventMap, AxonSpanName, EngineCapability, EngineCloud } from "@arcforge/types"
import { buildProvider, providerPool } from "@arcforge/engines/providers"
import { Engines, gather, type AxonProvider, type Catalogue, type EnginesT, type LocalRuntime } from "@arcforge/engines/catalogue"

type InferenceOpts = {
    blueprint: AxonBlueprint
    cloud: EngineCloud
    /** Machine-local inference, owned by the host/daemon rather than the agent. */
    local?: LocalRuntime
    /**
     * Where to report resolution cost. Optional so an embedded host or a
     * test can resolve roles without a session.
     */
    session?: InferenceReporter
}

/** The slice of the session this needs — commit spans, nothing else. */
export type InferenceReporter = {
    span<K extends AxonSpanName, T>(
        name: K,
        start: AxonEventMap[`${K}:start`],
        run: () => Promise<T>,
        complete?: (value: T) => Omit<AxonEventMap[`${K}:complete`], "durationMs">,
    ): Promise<T>
}

/**
 * Resolve this agent's declared engine roles against what its user has.
 *
 * Runs ONCE, at the Axon() seam, before the kernel exists and long before
 * the cognet loads — because a required role that nothing can fill has to
 * stop the boot. A brain that has already started is a brain that will reach
 * for an engine which is not there, at a point where the only thing left to
 * do about it is crash mid-wake.
 *
 * Lives in core rather than ring 0 for the same reason `base()` does:
 * gathering catalogues is network work against a user's providers, and the
 * kernel must stay a syscall table with no filesystem and no fetch of its
 * own.
 *
 * Returns undefined for a cognet that declared no roles. That is every agent
 * published before this existed, and they keep dispatching through the
 * single `engine:` exactly as before — the role layer is additive, not a
 * migration every author has to perform.
 */
export async function Inference(opts: InferenceOpts): Promise<EnginesT | undefined> {
    const carriedSlot = opts.blueprint.cognet
    const declared = carriedSlot.engines
        ?? ("definition" in carriedSlot ? carriedSlot.definition.engines : undefined)

    // No roles declared: nothing to resolve and nothing worth a span. Every
    // agent published before roles existed takes this path.
    if (!declared || Object.keys(declared).length === 0) return undefined
    if (!opts.session) return (await resolveRoles(opts)).engines

    const resolved = await opts.session.span(
        "axon:inference",
        { roles: Object.keys(declared) } as never,
        () => resolveRoles(opts),
        (value: Resolved) => ({
            bound: value.engines?.resolution.bound.length ?? 0,
            providers: value.providers,
            failures: value.failures,
            cached: value.cached,
        }) as never,
    )

    return resolved.engines
}

/**
 * What resolution produced, plus what it cost to produce.
 *
 * The counts ride on the return value rather than module state because a
 * fleet boots several agents in ONE process: anything held outside the call
 * would be read by whichever boot finished last, and a trace that reports
 * another agent's provider count is worse than one that reports none.
 */
type Resolved = {
    engines: EnginesT | undefined
    providers: number
    failures: number
    /** Whether the hosted catalogue was served without touching the wire. */
    cached: boolean
}

async function resolveRoles(opts: InferenceOpts): Promise<Resolved> {
    // Two carriers, one answer. The CLI form stamps requirements onto the
    // blueprint slot at prepare (so resolution can run without importing a
    // bundle); the live-definition form — tests, embedded hosts — has them
    // only on the definition itself. Reading both keeps a test cognet and a
    // published one on the same path, which is the whole point of the
    // definition escape hatch existing.
    const carried = opts.blueprint.cognet
    const requirements = carried.engines
        ?? ("definition" in carried ? carried.definition.engines : undefined)

    if (!requirements || Object.keys(requirements).length === 0) {
        return { engines: undefined, providers: 0, failures: 0, cached: false }
    }

    const pool = providerPool(opts.blueprint.profileProviders, opts.blueprint.config.providers)

    const providers = new Map<string, AxonProvider>()

    for (const declared of pool) {
        providers.set(declared.provider, buildProvider(declared, {
            cloud: opts.cloud,
            env: opts.blueprint.env,
            ...(opts.local ? { local: opts.local } : {}),
        }))
    }

    const gathered = await gatherTraced([...providers.values()], opts.session)
    const catalogue = gathered.catalogue

    const engines = Engines({
        requirements,
        capabilities: catalogue.capabilities,
        providers,
        // The agent's declared cortex choice. A preference on the primary
        // role, never a constraint — see AxonConfig.model.
        ...(opts.blueprint.config.model !== undefined ? { model: opts.blueprint.config.model } : {}),
    })

    // A required role with nothing to fill it stops here, naming what was
    // missing AND which sources could not answer — a user whose Ollama is
    // down needs to see that, not "no engine matched", which would send them
    // editing a config that is already correct.
    if (engines.resolution.missing.length > 0) {
        const unmet = engines.resolution.missing
            .map(entry => `  ${entry.role}: ${entry.reasons[0] ?? "no candidate in any declared provider"}`)
            .join("\n")
        const failed = catalogue.failures
            .map(failure => `  ${failure.provider}: ${failure.message}`)
            .join("\n")

        throw err("ENGINE_REQUIREMENTS_UNMET", {
            detail: `this cognet needs engines nothing available can supply:\n${unmet}`
                + (failed ? `\n\nproviders that could not answer:\n${failed}` : ""),
        })
    }

    // A pin the pool could not honour is a WARNING, not a failure: the agent
    // runs on what ranking chose and is fully usable. But it must be visible —
    // a user who picked a model and silently got another one has no way to
    // tell the picker worked at all. err() emits to the session's error
    // channel, which is what the TUI renders.
    const unhonoured = engines.resolution.unhonoured
    if (unhonoured) {
        const bound = engines.resolution.bound.find(entry => entry.requirement.primary)
            ?? engines.resolution.bound[0]

        err("ENGINE_PIN_UNAVAILABLE", {
            detail: `"${unhonoured.pin}" — ${unhonoured.reason}.`
                + (bound ? ` Running on ${bound.capability.provider}:${bound.capability.id} instead.` : ""),
            context: {
                pin: unhonoured.pin,
                ...(bound ? { using: `${bound.capability.provider}:${bound.capability.id}` } : {}),
            },
        })
    }

    return {
        engines: engines,
        providers: pool.length,
        failures: catalogue.failures.length,
        cached: gathered.cached,
    }
}


/**
 * gather(), with one span per provider.
 *
 * Providers answer CONCURRENTLY, which is the one case the envelope's
 * bracket-matching cannot recover nesting for — so these carry an explicit
 * spanId, exactly as engine calls do. Without them a slow boot says only
 * "inference took 300ms"; with them it says which source was slow, which is
 * the difference between a diagnosis and a shrug.
 *
 * Failures stay DATA, as gather() defines them: a provider that could not
 * answer closes its own span as :failed and the catalogue is still returned.
 */
async function gatherTraced(
    providers: readonly AxonProvider[],
    session?: InferenceReporter,
): Promise<{ catalogue: Catalogue; cached: boolean }> {
    if (!session) {
        const catalogue = await gather(providers)
        return { catalogue, cached: false }
    }

    const catalogue = await gather(providers.map(provider => ({
        ...provider,
        catalogue: () => {
            const spanId = crypto.randomUUID()
            return session.span(
                "axon:inference:provider",
                { provider: provider.name, spanId } as never,
                () => provider.catalogue(),
                (capabilities: EngineCapability[]) => ({
                    provider: provider.name,
                    spanId,
                    capabilities: capabilities.length,
                    cached: catalogueWasCached(provider),
                }) as never,
            )
        },
    })))

    return { catalogue, cached: providers.every(catalogueWasCached) }
}

/**
 * Did this provider answer from its own cache rather than the wire?
 *
 * Providers that cache expose `cachedAt` — a timestamp set when the last
 * answer was served from disk and cleared when it came from the network.
 * A provider that does not cache (Ollama: a localhost call cheaper than the
 * disk read that would cache it) never reports true, which is the honest
 * answer rather than a flattering one.
 */
function catalogueWasCached(provider: AxonProvider): boolean {
    return (provider as AxonProvider & { cachedAt?: number }).cachedAt !== undefined
}
