import type { AxonCloudClient, DeploymentRecord } from "@arcforge/cloud"

type DeploymentsOpts = {
    cloud: AxonCloudClient
}

/** A deployment the user can actually connect to: running, with a URL. */
export type ConnectableDeployment = {
    deploymentId: string
    agentId: string
    /** Registry name, e.g. "@cody/dave". */
    name: string
    url: string
    tier: string
    warmth: string
}

/**
 * The user's deployed agents — the connectable ones, cached.
 *
 * Cached deliberately: the local agent list is a synchronous disk read, so a
 * palette that awaited a network call to open would block on it. `list()` serves
 * whatever was last fetched (empty before the first fetch) and `refresh()` is the
 * only thing that touches the network. Callers refresh on boot and on demand;
 * the palette never waits.
 *
 * Only `running` deployments with a URL are returned. A provisioning or errored
 * deployment has nothing to attach to, so offering it in a palette would be
 * offering an action that cannot work.
 */
export function Deployments(opts: DeploymentsOpts) {
    let cache: ConnectableDeployment[] = []
    let lastError: Error | null = null

    function connectable(rows: DeploymentRecord[]): ConnectableDeployment[] {
        return rows
            .filter(row => row.status === "running" && row.url !== null && row.agentName !== null)
            .map(row => ({
                deploymentId: row.id,
                agentId: row.agentId,
                name: row.agentName!,
                url: row.url!,
                tier: row.tier,
                warmth: row.warmth,
            }))
    }

    return {
        /** Last fetched connectable deployments. Empty until refresh() has run. */
        list(): ConnectableDeployment[] {
            return cache
        },

        /** Why the last refresh failed, if it did. Surfaced, never swallowed. */
        get error(): Error | null {
            return lastError
        },

        /**
         * Re-fetch from the control plane. Logged-out or offline is not a crash —
         * the local agent list must still work — but the failure is recorded on
         * `error` so a caller can show it rather than silently listing nothing.
         */
        async refresh(): Promise<ConnectableDeployment[]> {
            try {
                cache = connectable(await opts.cloud.user.deployments.list())
                lastError = null
            } catch (cause) {
                lastError = cause instanceof Error ? cause : new Error(String(cause))
            }
            return cache
        },

        /** Look one up by registry name — what a palette selection resolves through. */
        find(name: string): ConnectableDeployment | null {
            return cache.find(item => item.name === name) ?? null
        },
    }
}

export type DeploymentsT = ReturnType<typeof Deployments>
