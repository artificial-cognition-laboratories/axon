import { HttpError, VaultConnectionError, type EngineCloud, type KeyConnectionProvider } from "@arcforge/types"
import { failure } from "../shared"

/** Resolves an explicit credential or the current account credential at request time. */
export function Credentials(opts: {
    provider: string
    connection: KeyConnectionProvider
    cloud: EngineCloud
    env: Record<string, string | undefined>
    variable: string
    key?: string
    url?: string
}) {
    return {
        async resolve(): Promise<{ key: string; revision: string }> {
            const explicit = opts.key ?? opts.env[opts.variable]
            if (explicit !== undefined) {
                if (!explicit) throw failure({ code: "AUTH_NOT_CONNECTED", message: `${opts.provider}: the explicit credential is empty`, retryable: false, provider: opts.provider })
                return { key: explicit, revision: explicit }
            }
            if (opts.url !== undefined) throw failure({ code: "INVALID_REQUEST", message: new VaultConnectionError("VAULT_CREDENTIAL_ENDPOINT", opts.connection).message, retryable: false, provider: opts.provider })
            const connections = opts.cloud.user.vault.connections
            if (!connections.credential) throw failure({ code: "AUTH_NOT_CONNECTED", message: `${opts.provider}: connect this provider to your Axon account, or supply an explicit key`, retryable: false, provider: opts.provider })
            try {
                const credential = await connections.credential(opts.connection)
                return { key: credential.accessToken, revision: credential.revision }
            } catch (error) {
                if (!(error instanceof HttpError) && !(error instanceof VaultConnectionError)) throw error
                const status = error instanceof HttpError ? error.status : error.statusCode
                throw failure({ code: status === 503 || status >= 500 ? "TRANSPORT" : status === 429 ? "RATE_LIMIT" : "AUTH_NOT_CONNECTED",
                    message: error.message, retryable: status >= 500 || status === 429, provider: opts.provider, status: status })
            }
        },
    }
}
