import type { EngineCloud, ProviderEntry } from "@arcforge/types"

/** Discovers account sources only when the machine has no explicit provider policy. */
export function Accounts(opts: {
    connections: EngineCloud["user"]["vault"]["connections"]
    auth: EngineCloud["user"]["auth"]
    profile: readonly ProviderEntry[] | undefined
}) {
    return {
        async list(): Promise<ProviderEntry[]> {
            if (opts.profile !== undefined) return []
            // Signed out is an ordinary state, not a failed vault request.
            if (opts.auth !== undefined && opts.auth.token === undefined) return []
            if (!opts.connections.list) throw new Error("Account provider discovery is not wired")
            const connections = await opts.connections.list()
            return connections.filter(connection => connection.status === "active")
                .map(connection => ({ provider: connection.route }))
        },
    }
}
