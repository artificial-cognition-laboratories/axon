import type { DirectDefinition } from "./direct"
import type { SdkLanguageModel } from "./types"

/**
 * DIRECT_PROVIDERS — every provider reachable with the user's own key,
 * through the Vercel AI SDK.
 *
 * ── What a row is, and why it is this small ───────────────────────────────
 *
 * A row is a NAME, an environment variable, and a lazy import. That is all,
 * because everything else about a provider is already known somewhere better:
 * which models it can serve comes from the registry catalogue (the `via` on a
 * canonical model's routes), and how to talk to it comes from the SDK package.
 * A row that also listed models would be a second place for the catalogue to
 * be wrong.
 *
 * The `name` MUST match the `via` the backend publishes for this route —
 * HostedProvider filters the catalogue by it, so a mismatch produces a
 * provider that resolves nothing and reports no error. The two are declared
 * apart because one lives server-side (curation reaches every agent with no
 * client release) and one lives here (the transport ships with the client).
 *
 * ── Lazy, always ─────────────────────────────────────────────────────────
 *
 * Each `load` is an `import()` of an optional peer dependency. A user who
 * declares two providers installs two packages; nobody pays for the other
 * nine. That is only true while these stay dynamic — a top-level import of
 * any `@ai-sdk/*` package in this file makes every provider mandatory for
 * everyone, which is the one mistake this file exists to prevent.
 *
 * The packages are ALSO devDependencies at the repo root. That is not a
 * contradiction: the root install is what lets `tsc` resolve the dynamic
 * imports below and typecheck this file, and what lets the test suite
 * exercise a real provider. Neither reaches a consumer — `peerDependencies`
 * with `optional: true` is what ships, so an installing user still chooses
 * which providers they pay for.
 *
 * ── Env var names are the SDK's, not ours ────────────────────────────────
 *
 * Each `env` is the variable the provider's own package already reads, taken
 * from that package's source rather than invented here. A user who has
 * `ANTHROPIC_API_KEY` set for anything else on their machine has it set for
 * this, and an Axon-specific name would be a second thing to configure for no
 * gain. It is named explicitly anyway rather than left to the SDK's internal
 * lookup: drivers must not read `process.env` (they are handed a resolved
 * environment), and a provider that silently fell back to the ambient
 * process would ignore the agent's own configuration.
 */

/**
 * The shape every `@ai-sdk/*` provider factory shares.
 *
 * `createX({ apiKey })` returns a callable that maps a model id to a model.
 * Spelled structurally for the same reason as everything else in ./types.ts —
 * the packages are optional, so their types cannot be imported here.
 */
type SdkFactory = (settings: { apiKey: string; baseURL?: string }) => (model: string) => SdkLanguageModel

/**
 * A first-party provider: one package, one factory, one env var.
 *
 * Nine of the eleven are exactly this, so the row is generated rather than
 * transcribed — the differences that matter (which package, which variable)
 * stay visible in the table and the identical wiring is stated once.
 */
function first(name: string, env: string, load: () => Promise<SdkFactory>): DirectDefinition {
    return {
        name,
        env,
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
        name,
        env,
        async load(key, url) {
            const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
            return createOpenAICompatible({
                name,
                apiKey: key,
                baseURL: url ?? baseURL,
            }) as unknown as (model: string) => SdkLanguageModel
        },
    }
}

export const DIRECT_PROVIDERS: Record<string, DirectDefinition> = {
    anthropic: first("anthropic", "ANTHROPIC_API_KEY", async () =>
        (await import("@ai-sdk/anthropic")).createAnthropic as unknown as SdkFactory),

    openai: first("openai", "OPENAI_API_KEY", async () =>
        (await import("@ai-sdk/openai")).createOpenAI as unknown as SdkFactory),

    // The variable is the SDK's own, and it is NOT "GOOGLE_API_KEY" — the
    // package reads GOOGLE_GENERATIVE_AI_API_KEY, and quietly renaming it here
    // would mean a user with a working Google setup gets told they have no
    // credential.
    google: first("google", "GOOGLE_GENERATIVE_AI_API_KEY", async () =>
        (await import("@ai-sdk/google")).createGoogleGenerativeAI as unknown as SdkFactory),

    groq: first("groq", "GROQ_API_KEY", async () =>
        (await import("@ai-sdk/groq")).createGroq as unknown as SdkFactory),

    cerebras: first("cerebras", "CEREBRAS_API_KEY", async () =>
        (await import("@ai-sdk/cerebras")).createCerebras as unknown as SdkFactory),

    mistral: first("mistral", "MISTRAL_API_KEY", async () =>
        (await import("@ai-sdk/mistral")).createMistral as unknown as SdkFactory),

    deepseek: first("deepseek", "DEEPSEEK_API_KEY", async () =>
        (await import("@ai-sdk/deepseek")).createDeepSeek as unknown as SdkFactory),

    xai: first("xai", "XAI_API_KEY", async () =>
        (await import("@ai-sdk/xai")).createXai as unknown as SdkFactory),

    perplexity: first("perplexity", "PERPLEXITY_API_KEY", async () =>
        (await import("@ai-sdk/perplexity")).createPerplexity as unknown as SdkFactory),

    zai: first("zai", "ZAI_API_KEY", async () =>
        (await import("@ai-sdk/zai")).createZai as unknown as SdkFactory),

    // No first-party package exists. Moonshot publishes an OpenAI-compatible
    // endpoint, which is the honest way in — and the reason this row looks
    // different from the ten above is that it IS different, not because the
    // abstraction leaked.
    moonshot: compatible("moonshot", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1"),
}
