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
