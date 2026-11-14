import { isConnectionProvider, type KeyConnectionProvider } from "@arcforge/types"
import type { DirectDefinition } from "./direct"
import type { SdkLanguageModel } from "./types"

/**
 * AI SDK transports, keyed by registry route. Account connection IDs remain
 * distinct (OpenAI API is openai-api, while Codex is OAuth).
 *
 * Every package is a runtime dependency, loaded lazily through a literal import
 * so Bun bundles it into shipped hosts. Connecting a provider never requires
 * the user to install packages. Registry metadata owns models and capabilities;
 * these rows own only SDK construction and explicit environment-variable names.
 */
type SdkFactory = (settings: { apiKey: string; baseURL?: string; name?: string }) => (model: string) => SdkLanguageModel

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object"
}

function isFactory(value: unknown): value is SdkFactory {
    return typeof value === "function"
}

/** The named factory every first-party AI SDK provider exports. */
function factory(load: () => Promise<unknown>, exportName: string): () => Promise<SdkFactory> {
    return async () => {
        const loaded = await load()
        if (!isRecord(loaded)) throw new Error("Provider SDK returned an invalid module")
        const create = loaded[exportName]
        if (!isFactory(create)) throw new Error(`Provider SDK has no '${exportName}' factory`)
        return create
    }
}

/**
 * A first-party provider: one package, one factory, one env var.
 *
 * Most transports are exactly this, so the row is generated rather than
 * transcribed — the differences that matter (which package, which variable)
 * stay visible in the table and the identical wiring is stated once.
 */
function first(name: string, env: string, load: () => Promise<SdkFactory>): DirectDefinition {
    return {
        name: name,
        env: env,
        connection: name === "openai" ? "openai-api" : connection(name),
        async load(key, url) {
            const create = await load()
            return create({ apiKey: key, ...(url ? { baseURL: url } : {}) })
        },
    }
}

/**
 * A provider with no first-party package, reached through its
 * OpenAI-compatible endpoint.
 *
 * Honest about what it is: the SDK's `openai-compatible` adapter pointed at a
 * documented base URL. It works because these vendors publish a
 * chat-completions surface, and it will keep working exactly as long as they
 * do — which is why the default endpoint is stated here and overridable by
 * the user rather than buried in a package we do not control.
 */
function compatible(name: string, env: string, baseURL: string): DirectDefinition {
    return {
        name: name,
        env: env,
        connection: name === "openai" ? "openai-api" : connection(name),
        async load(key, url) {
            const create = await factory(() => import("@ai-sdk/openai-compatible"), "createOpenAICompatible")()
            return create({
                name: name,
                apiKey: key,
                baseURL: url ?? baseURL,
            })
        },
    }
}

export const DIRECT_PROVIDERS: Record<string, DirectDefinition> = {
    anthropic: first("anthropic", "ANTHROPIC_API_KEY", factory(() => import("@ai-sdk/anthropic"), "createAnthropic")),

    openai: first("openai", "OPENAI_API_KEY", factory(() => import("@ai-sdk/openai"), "createOpenAI")),

    // The variable is the SDK's own, and it is NOT "GOOGLE_API_KEY" — the
    // package reads GOOGLE_GENERATIVE_AI_API_KEY, and quietly renaming it here
    // would mean a user with a working Google setup gets told they have no
    // credential.
    google: first("google", "GOOGLE_GENERATIVE_AI_API_KEY", factory(() => import("@ai-sdk/google"), "createGoogleGenerativeAI")),

    groq: first("groq", "GROQ_API_KEY", factory(() => import("@ai-sdk/groq"), "createGroq")),

    cerebras: first("cerebras", "CEREBRAS_API_KEY", factory(() => import("@ai-sdk/cerebras"), "createCerebras")),

    mistral: first("mistral", "MISTRAL_API_KEY", factory(() => import("@ai-sdk/mistral"), "createMistral")),

    deepseek: first("deepseek", "DEEPSEEK_API_KEY", factory(() => import("@ai-sdk/deepseek"), "createDeepSeek")),

    xai: first("xai", "XAI_API_KEY", factory(() => import("@ai-sdk/xai"), "createXai")),

    perplexity: first("perplexity", "PERPLEXITY_API_KEY", factory(() => import("@ai-sdk/perplexity"), "createPerplexity")),

    zai: first("zai", "ZAI_API_KEY", factory(() => import("@ai-sdk/zai"), "createZai")),

    // These routes use the SDK's compatible adapter at their official endpoints.
    openrouter: compatible("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"),
    moonshot: compatible("moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1"),
}

function connection(name: string): KeyConnectionProvider {
    if (!isConnectionProvider(name) || name === "codex") throw new Error(`Provider SDK has no API-key connection: ${name}`)
    return name
}
