import type { AxonEngineDef, EngineEffort, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import { Collect, UsageDriver, failure } from "../shared"
import { OpenRouterBackend } from "./backend"

export type OpenRouterOptions = {
    /** Model ID as listed on openrouter.ai e.g. "openai/gpt-4o", "anthropic/claude-sonnet-4-6" */
    model: string
    /** Requested reasoning effort. OpenRouter may ignore it for models without reasoning controls. */
    effort?: EngineEffort
    /** Override base URL. Defaults to https://openrouter.ai/api/v1/chat/completions */
    baseUrl?: string
}

/**
 * OpenRouter engine — routes inference through the user's own OpenRouter
 * account (BYOK). The key comes from the agent's resolved env
 * (OPENROUTER_API_KEY) when set, otherwise from the account vault
 * (`:providers openrouter connect`) — minted per request through the cloud
 * client, so rotation never rebuilds the driver.
 *
 * ```ts
 * import { OpenRouter } from "@arcforge/engines"
 *
 * export default defineAgent({
 *     providers: [OpenRouter()],
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/openrouter
 */
export function OpenRouter(options: OpenRouterOptions): AxonEngineDef {
    return {
        name: "openrouter",
        model: options.model,
        ...(options.effort !== undefined ? { effort: options.effort } : {}),

        create({ env, cloud }): AxonEngineDriver {
            // Explicit agent env wins; otherwise the account vault supplies
            // the key per request (connected via `:providers openrouter
            // connect`). Neither being set fails loudly at first use with
            // the vault's VAULT_NOT_CONNECTED — construction stays wiring.
            const envKey = env.OPENROUTER_API_KEY
            const key = envKey !== undefined
                ? async () => envKey
                : async () => {
                    if (options.baseUrl !== undefined) throw failure({ code: "INVALID_REQUEST", message: "A custom OpenRouter endpoint requires an explicit key; account credentials cannot be sent to an override.", retryable: false, provider: "openrouter", model: options.model })
                    return (await cloud.user.vault.connections.openrouter.token()).accessToken
                }

            const backend = OpenRouterBackend({
                key,
                model: options.model,
                ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
            })

            const driver: AxonEngineDriver = {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    const collect = Collect({ provider: "openrouter", model: options.model })

                    for await (const delta of backend.stream(req)) {
                        const event = collect.feed(delta)
                        if (event) yield event
                    }

                    yield collect.done({ ...(req.signal ? { signal: req.signal } : {}) })
                },
            }
            return UsageDriver({ driver: driver, cloud: cloud, provider: "openrouter", model: options.model, source: envKey !== undefined ? "explicit" : "account" })
        },
    }
}
