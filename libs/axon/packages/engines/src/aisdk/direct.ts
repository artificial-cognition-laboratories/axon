import type { EngineCloud, EngineEffort, KeyConnectionProvider } from "@arcforge/types"
import { HostedProvider, type AxonProvider } from "../catalogue"
import { UsageDriver, failure } from "../shared"
import { AiSdk } from "./driver"
import type { SdkLanguageModel } from "./types"
import { Credentials } from "./credentials"

/** Provider SDKs ship with the runtime; literal imports let the CLI bundle them. */
export type DirectDefinition = {
    /** Route name — must equal the `via` the registry publishes for this provider. */
    name: string

    /** Environment variable carrying the user's key. */
    env: string
    /** Account connection identity; distinct from the inference route. */
    connection: KeyConnectionProvider

    /** Lazy SDK client construction, called again only when its credential changes. */
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
 * Explicit credentials take precedence over the account vault. Account
 * credentials are resolved at each request through the cloud cache; a changed
 * revision replaces the SDK client without restarting the driver. Keys live
 * only in host memory. Provider SDKs own all inference HTTP transport.
 */
export function DirectProvider(opts: DirectOpts): AxonProvider {
    const { definition } = opts

    const credentials = Credentials({
        provider: definition.name, connection: definition.connection, cloud: opts.cloud,
        env: opts.env, variable: definition.env,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.url !== undefined ? { url: opts.url } : {}),
    })
    let current: { revision: string; factory: Promise<(model: string) => SdkLanguageModel> } | undefined

    async function client(): Promise<(model: string) => SdkLanguageModel> {
        const credential = await credentials.resolve()
        if (current?.revision === credential.revision) return current.factory
        const factory = definition.load(credential.key, opts.url)
        current = { revision: credential.revision, factory: factory }
        try { return await factory } catch (error) {
            if (current?.factory === factory) current = undefined
            throw failure({ code: "INVALID_REQUEST", message: `${definition.name}: could not load its provider SDK`, retryable: false, provider: definition.name, cause: error })
        }
    }

    return HostedProvider({
        name: definition.name,
        cloud: opts.cloud,
        driver: model => {
            const driver = {
                ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
                async *stream(req) {
                    const driver = AiSdk({
                        provider: definition.name,
                        model: (await client())(model),
                        ...(opts.effort ? { effort: opts.effort } : {}),
                    })
                    yield* driver.stream(req)
                },
            } satisfies import("@arcforge/types").AxonEngineDriver
            return UsageDriver({ driver: driver, cloud: opts.cloud, provider: definition.connection, model: model,
                source: opts.key !== undefined || opts.env[definition.env] !== undefined ? "explicit" : "account" })
        },
        ...(opts.slots !== undefined ? { slots: opts.slots } : {}),
    })
}
