import type { EngineCloud, EngineEffort } from "@arcforge/types"
import { HostedProvider, type AxonProvider } from "../catalogue"
import { failure } from "../shared"
import { AiSdk } from "./driver"
import type { SdkLanguageModel } from "./types"

/**
 * How one `@ai-sdk/*` package is reached.
 *
 * `load` is ASYNC and called lazily, once, when a model is first built.
 * Every provider package is an optional peer dependency: a user who declared
 * `Anthropic()` installs `@ai-sdk/anthropic` and nobody else pays for it, in
 * install size or in bundle. An eager top-level import would make all of them
 * mandatory for everyone, which is the opposite of the point.
 *
 * The import is also the reason this is a function rather than a module
 * reference — a static `import("@ai-sdk/anthropic")` in a package that does
 * not depend on it fails at build, so the specifier lives in the definition
 * and the definition is what a provider file supplies.
 */
export type DirectDefinition = {
    /** Route name — must equal the `via` the registry publishes for this provider. */
    name: string

    /** Environment variable carrying the user's key. */
    env: string

    /**
     * Load the SDK package and build a model factory bound to a credential.
     *
     * Returns the factory rather than a model because a provider serves MANY
     * models: resolution picks one per role, and each `create()` asks for its
     * own. Loading once and binding once means the package import and the
     * client construction are each paid a single time.
     *
     * `url` is the user's endpoint override when they set one — a self-hosted
     * gateway, a regional endpoint, a proxy. A definition that has no notion
     * of one ignores it; a definition built on an OpenAI-compatible endpoint
     * uses it in place of its own default.
     */
    load(key: string, url?: string): Promise<(model: string) => SdkLanguageModel>
}

type DirectOpts = {
    definition: DirectDefinition
    cloud: EngineCloud
    /** Resolved agent environment — no process.env reads inside a provider. */
    env: Record<string, string | undefined>
    /** Own credential from the user's declaration, overriding the environment. */
    key?: string
    /** Endpoint override from the user's declaration — self-hosted gateways, regional endpoints. */
    url?: string
    effort?: EngineEffort
    slots?: number
}

/**
 * A provider reached directly with the user's own key, through the AI SDK.
 *
 * Catalogue and resolution are `HostedProvider`'s, unchanged: the registry
 * publishes a `via` for this route on every model that can serve it, and the
 * shared implementation filters on the name. That is the whole reason routes
 * were modelled as an array on a canonical model — a new provider is a route
 * in the catalogue plus a transport here, and nothing in between has to know.
 *
 * BYOK by environment, deliberately for now: the key is read from the
 * agent's resolved env, not from the account vault. That means a direct
 * provider works wherever the user controls the environment — a terminal, a
 * self-hosted box — and a DEPLOYED agent needs the key in its deployment env
 * or it should use a vaulted route instead. Vaulting these is additive later
 * and changes nothing here but where `key` comes from.
 */
export function DirectProvider(opts: DirectOpts): AxonProvider {
    const { definition } = opts

    // Resolved once per model rather than per call: the SDK client is a
    // closure over a key and a fetch, so rebuilding it per request would buy
    // nothing. Cached as a promise so concurrent first calls import once.
    let factory: Promise<(model: string) => SdkLanguageModel> | undefined

    function client(): Promise<(model: string) => SdkLanguageModel> {
        if (factory) return factory

        // Read at USE, not at construction. A profile listing eight providers
        // must load with none of their keys present — declaring a provider is
        // not a claim to have configured it, and failing at boot would make an
        // unused declaration fatal.
        const key = opts.key ?? opts.env[definition.env]
        if (!key) {
            throw failure({
                code: "AUTH_NOT_CONNECTED",
                message: `${definition.name}: no credential — set ${definition.env}, or pass a key to ${definition.name}({ key })`,
                retryable: false,
                provider: definition.name,
            })
        }

        factory = definition.load(key, opts.url).catch((cause: unknown) => {
            factory = undefined
            throw failure({
                code: "INVALID_REQUEST",
                message: `${definition.name}: could not load its provider package — install it alongside @arcforge/engines`,
                retryable: false,
                provider: definition.name,
                cause,
            })
        })
        return factory
    }

    return HostedProvider({
        name: definition.name,
        cloud: opts.cloud,
        driver: model => {
            // HostedProvider's `driver` is synchronous — a driver is built at
            // boot and must not await. The lazy import is therefore deferred
            // into the first stream() call, where an await is already
            // happening, rather than forced up into construction.
            let bound: Promise<SdkLanguageModel> | undefined
            const load = () => (bound ??= client().then(build => build(model)))

            return {
                async *stream(req) {
                    const driver = AiSdk({
                        provider: definition.name,
                        model: await load(),
                        ...(opts.effort ? { effort: opts.effort } : {}),
                    })
                    yield* driver.stream(req)
                },
            }
        },
        ...(opts.slots !== undefined ? { slots: opts.slots } : {}),
    })
}
