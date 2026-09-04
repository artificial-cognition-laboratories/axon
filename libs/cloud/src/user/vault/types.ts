/**
 * Vault domain types — the client shapes of the backend's vault organ.
 * The full CodexCredential (with its refresh token) exists client-side
 * only for the one moment between finishing the PKCE flow and uploading
 * it; after that, hosts only ever see ConnectionToken.
 */

/** The full Codex OAuth grant — output of the local PKCE flow, input to connect()'s upload. Never persisted client-side. */
export type CodexCredential = {
    accessToken: string
    refreshToken: string
    /** unix ms */
    expiresAt: number
    /** chatgpt_account_id decoded from the access token */
    accountId: string
    /** unix ms — when the user connected */
    connectedAt: number
}

/** Narrow provider token minted by the backend — no refresh token or raw grant, by construction. */
export type ConnectionToken = {
    accessToken: string
    /** unix ms — when the client should re-mint */
    expiresAt: number
    /** Provider account identifier, when the provider has one. */
    accountId?: string
}

/** OpenAI's token always carries the chatgpt_account_id — Codex requests need it as a header. */
export type OpenaiConnectionToken = ConnectionToken & { accountId: string }

export type ConnectionStatus =
    | { connected: false }
    | { connected: true; status: "active" | "broken"; connectedAt: number }

export type VaultSecretMeta = {
    name: string
    createdAt: string
    updatedAt: string
}

/**
 * One rate-limit window, as chatgpt.com reports it.
 *
 * A subscription has two that matter: a short rolling window (5h on Plus) and
 * a long one (7d). They are reported separately because they are exhausted
 * separately — a burst spends the first while the second barely moves, and a
 * user who has hit one needs to know WHICH, since only one of them clears in
 * an afternoon.
 */
export type CodexUsageWindow = {
    /** 0–100. What fraction of this window's allowance is spent. */
    usedPercent: number
    /** Seconds until this window resets. */
    resetAfterSeconds: number
    /** The window's own length in seconds — 18000 for 5h, 604800 for 7d. */
    windowSeconds: number
}

/**
 * A Codex subscription's current usage.
 *
 * Read straight from chatgpt.com with a narrow vaulted token, not proxied
 * through the backend: the token is already minted for exactly this account,
 * the answer is per-user and changes by the minute, and a proxy would add a
 * hop plus a cache to a value whose whole worth is being current.
 */
export type CodexUsage = {
    /** "plus", "pro", "team", … — what the account is on. */
    plan: string
    /** True when the account is currently refused further calls. */
    limitReached: boolean
    /** The short rolling window — the one a burst exhausts. */
    primary: CodexUsageWindow
    /** The long window, when the plan has one. */
    secondary: CodexUsageWindow | null
}
