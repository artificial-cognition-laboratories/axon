/** Public account connection identities; OAuth Codex and OpenAI API are distinct. */
export const CONNECTION_PROVIDERS = {
    codex: { name: "Codex", route: "codex", auth: "oauth", setupUrl: "https://chatgpt.com" },
    openrouter: { name: "OpenRouter", route: "openrouter", auth: "key", setupUrl: "https://openrouter.ai/keys" },
    anthropic: { name: "Anthropic", route: "anthropic", auth: "key", setupUrl: "https://platform.claude.com/settings/keys" },
    "openai-api": { name: "OpenAI API", route: "openai", auth: "key", setupUrl: "https://platform.openai.com/api-keys" },
    google: { name: "Google", route: "google", auth: "key", setupUrl: "https://aistudio.google.com/apikey" },
    groq: { name: "Groq", route: "groq", auth: "key", setupUrl: "https://console.groq.com/keys" },
    cerebras: { name: "Cerebras", route: "cerebras", auth: "key", setupUrl: "https://cloud.cerebras.ai" },
    mistral: { name: "Mistral", route: "mistral", auth: "key", setupUrl: "https://console.mistral.ai" },
    deepseek: { name: "DeepSeek", route: "deepseek", auth: "key", setupUrl: "https://platform.deepseek.com/api_keys" },
    xai: { name: "xAI", route: "xai", auth: "key", setupUrl: "https://console.x.ai" },
    perplexity: { name: "Perplexity", route: "perplexity", auth: "key", setupUrl: "https://www.perplexity.ai/settings/api" },
    zai: { name: "Z.AI", route: "zai", auth: "key", setupUrl: "https://z.ai/manage-apikey/apikey-list" },
    moonshot: { name: "Moonshot", route: "moonshot", auth: "key", setupUrl: "https://platform.moonshot.ai" },
} as const

export type ConnectionProvider = keyof typeof CONNECTION_PROVIDERS
export type KeyConnectionProvider = Exclude<ConnectionProvider, "codex">

export function isConnectionProvider(value: string): value is ConnectionProvider {
    return Object.hasOwn(CONNECTION_PROVIDERS, value)
}

/** Credential material is transient host memory; revision is an opaque cache identity. */
export type ProviderCredential = {
    accessToken: string
    expiresAt: number
    revision: string
    accountId?: string
}

export type ProviderConnection = {
    provider: ConnectionProvider
    route: string
    connectedAt: number
    updatedAt: number
    revision: string
    status: "active" | "broken"
    /** Stored means no documented, non-billable authentication probe is available. */
    verification: "verified" | "stored"
}

const ERRORS = {
    VAULT_PROVIDER_UNKNOWN: { status: 404, message: "This provider connection is not supported." },
    VAULT_CREDENTIAL_INVALID: { status: 400, message: "The provider rejected this credential. Check it and try again." },
    VAULT_PROVIDER_FORBIDDEN: { status: 403, message: "This credential does not have permission to verify the provider connection." },
    VAULT_VERIFY_UNAVAILABLE: { status: 503, message: "The provider could not verify the connection. Try again later." },
    VAULT_CONNECTION_NOT_FOUND: { status: 404, message: "This provider is not connected. Connect it to your Axon account first." },
    VAULT_CONNECTION_BROKEN: { status: 409, message: "This provider connection needs to be reconnected." },
    VAULT_IDENTITY_CHANGED: { status: 409, message: "The signed-in account changed during this operation. Try again." },
    VAULT_CONNECTION_CHANGED: { status: 409, message: "This provider connection changed during this operation. Try again." },
    VAULT_CREDENTIAL_ENDPOINT: { status: 400, message: "A custom endpoint requires an explicit credential. Account credentials cannot be sent to an endpoint override." },
    VAULT_RESPONSE_INVALID: { status: 502, message: "The provider connection service returned an invalid response." },
} as const

/** Safe boundary errors; never include provider response bodies or credential input. */
export class VaultConnectionError extends Error {
    readonly code: keyof typeof ERRORS
    readonly statusCode: number
    readonly provider: string

    constructor(code: keyof typeof ERRORS, provider: string) {
        super(ERRORS[code].message)
        this.name = "VaultConnectionError"
        this.code = code
        this.statusCode = ERRORS[code].status
        this.provider = provider
    }
}
