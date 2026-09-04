import type { HttpClient } from "../../platform/http"
import { codexOAuth } from "./codex"
import type { CodexUsage, ConnectionStatus, ConnectionToken, OpenaiConnectionToken, VaultSecretMeta } from "./types"

/** Skip the cached token when it has less than this long to live. */
const TOKEN_MARGIN_MS = 30_000

type VaultOpts = {
    http: HttpClient
    /** "browser" drops connect() — the PKCE flow needs a local callback server. Everything else is plain fetch. */
    runtime: "node" | "browser"
}

/**
 * Vault — the client of the backend's encrypted credential store. Secrets
 * are inert KV (agent env values); connections are provider credentials
 * (OAuth grants or plain API keys) owned by the backend from upload on.
 * Hosts mint narrow short-lived tokens via token() — cached until expiry,
 * so per-request resolution costs nothing.
 */
export function Vault(opts: VaultOpts) {
    return {
        secrets: {
            /** Names + timestamps only — values never come back down. */
            list() {
                return opts.http.get<VaultSecretMeta[]>("/api/user/vault/secrets")
            },
            async set(name: string, value: string): Promise<void> {
                await opts.http.put(`/api/user/vault/secrets/${encodeURIComponent(name)}`, { value })
            },
            async delete(name: string): Promise<void> {
                await opts.http.delete(`/api/user/vault/secrets/${encodeURIComponent(name)}`)
            },
        },

        connections: {
            openai: OpenaiConnection(opts),
            openrouter: OpenrouterConnection(opts),
        },
    }
}

/**
 * The provider-agnostic half of a connection: upload the credential the
 * provider-specific connect() produced, then mint/status/disconnect
 * against the backend's generic [provider] routes. Each provider spreads
 * this and adds its own connect().
 */
function Connection<TToken extends ConnectionToken>(opts: VaultOpts, provider: string) {
    let cached: TToken | null = null

    return {
        /** Hand the full credential to the backend — from here on it owns the grant. */
        async upload(credential: unknown): Promise<void> {
            await opts.http.put(`/api/user/vault/connections/${provider}`, credential)
            cached = null
        },

        /** Narrow short-lived token, cached until expiry. The backend refreshes server-side when stale. */
        async token(): Promise<TToken> {
            if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached
            cached = await opts.http.get<TToken>(`/api/user/vault/connections/${provider}/token`)
            return cached
        },

        status() {
            return opts.http.get<ConnectionStatus>(`/api/user/vault/connections/${provider}`)
        },

        async disconnect(): Promise<void> {
            await opts.http.delete(`/api/user/vault/connections/${provider}`)
            cached = null
        },
    }
}

/**
 * OpenAI (Codex) — OAuth grant. connect() runs the interactive PKCE flow
 * locally and uploads the grant; from then on the backend owns it and
 * token() is the only credential read path.
 */
function OpenaiConnection(opts: VaultOpts) {
    const { upload, ...connection } = Connection<OpenaiConnectionToken>(opts, "openai")

    return {
        /**
         * Run the OAuth flow on this machine and hand the grant to the
         * backend. `open` shows the authorization URL; `paste` is the
         * fallback when the local callback port is busy.
         */
        async connect(input: { open: (url: string) => void | Promise<void>; paste?: () => Promise<string> }): Promise<void> {
            if (opts.runtime === "browser") {
                throw new Error("vault.connections.openai.connect is not available when AxonCloud({ runtime: \"browser\" }) — the PKCE flow needs a local callback server")
            }
            const credential = await codexOAuth.login(input)
            await upload(credential)
        },

        /**
         * The subscription's current usage — percent spent, and when it resets.
         *
         * Read STRAIGHT from chatgpt.com with the narrow vaulted token rather
         * than proxied through our backend. The token is already minted for
         * exactly this account and already cached until expiry, the answer is
         * per-user and changes by the minute, and a proxy would add a hop plus
         * a cache to a value whose entire worth is being current.
         *
         * `null` when the account has no Codex connection. That is an absent
         * entitlement, not a failure — a user who has never connected Codex is
         * in a perfectly ordinary state, and a surface asking "what is my
         * usage" should render nothing rather than an error.
         *
         * Upstream failures THROW. A caller that cannot tell "not connected"
         * from "chatgpt.com is down" would show 0% for an outage, which is the
         * one wrong answer here: it reads as headroom the user does not have.
         */
        async usage(): Promise<CodexUsage | null> {
            const status = await connection.status()
            if (!status.connected || status.status !== "active") return null

            const token = await connection.token()
            const response = await fetch(
                "https://chatgpt.com/backend-api/codex/usage",
                {
                    headers: {
                        Authorization: `Bearer ${token.accessToken}`,
                        ...(token.accountId ? { "chatgpt-account-id": token.accountId } : {}),
                        originator: "codex_cli_rs",
                    },
                    signal: AbortSignal.timeout(8_000),
                },
            )
            if (!response.ok) {
                throw new Error(`CODEX_USAGE_FAILED: ${response.status} reading the account's usage`)
            }

            return normalizeUsage(await response.json())
        },

        ...connection,
    }
}

/**
 * chatgpt.com's usage payload, reduced to what a surface renders.
 *
 * Normalised HERE rather than passed through, so the wire's shape stays this
 * module's business: `used_percent`, `reset_after_seconds` and the
 * primary/secondary split are OpenAI's vocabulary, and every consumer learning
 * it would make a rename upstream a change in the TUI.
 */
function normalizeUsage(body: unknown): CodexUsage {
    const raw = body as {
        plan_type?: string
        rate_limit?: {
            limit_reached?: boolean
            primary_window?: { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number }
            secondary_window?: { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number } | null
        }
    }

    const window = (raw: { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number } | null | undefined) =>
        raw
            ? {
                usedPercent: raw.used_percent ?? 0,
                resetAfterSeconds: raw.reset_after_seconds ?? 0,
                windowSeconds: raw.limit_window_seconds ?? 0,
            }
            : null

    const primary = window(raw.rate_limit?.primary_window)
    if (!primary) throw new Error("CODEX_USAGE_FAILED: no primary window in the usage response")

    return {
        plan: raw.plan_type ?? "unknown",
        limitReached: raw.rate_limit?.limit_reached === true,
        primary,
        secondary: window(raw.rate_limit?.secondary_window),
    }
}

/**
 * OpenRouter — plain BYOK API key. connect() uploads the user-supplied
 * key; the backend verifies it against OpenRouter before accepting it, so
 * a bad key fails loudly here rather than at first inference.
 */
function OpenrouterConnection(opts: VaultOpts) {
    const { upload, ...connection } = Connection(opts, "openrouter")

    return {
        /** Store a user-supplied OpenRouter API key (openrouter.ai/keys). */
        async connect(input: { key: string }): Promise<void> {
            const key = input.key.trim()
            if (!key) throw new Error("OPENROUTER_KEY_REQUIRED: paste your OpenRouter API key — get one at openrouter.ai/keys")
            await upload({ key, connectedAt: Date.now() })
        },

        ...connection,
    }
}

export type VaultHandle = ReturnType<typeof Vault>
