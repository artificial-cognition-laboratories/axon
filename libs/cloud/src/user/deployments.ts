import type { HttpClient } from "../platform/http"
import { rows, str, strOrNull } from "../platform/parse"
import type { DeploymentRecord } from "../registry/agents/types"

function parseDeploymentRecord(data: Record<string, unknown>): DeploymentRecord {
    return {
        id: str(data, "id"),
        agentId: str(data, "agentId"),
        agentName: strOrNull(data, "agentName"),
        tier: str(data, "tier"),
        warmth: str(data, "warmth"),
        status: str(data, "status"),
        url: strOrNull(data, "url"),
        createdAt: str(data, "createdAt"),
        lastError: strOrNull(data, "lastError"),
        axonBaseVersion: strOrNull(data, "axonBaseVersion"),
    }
}

type DeploymentsOpts = {
    http: HttpClient
}

/**
 * The caller's own deployments — the list surface. Per-deployment actions
 * (start/stop/redeploy/secrets) live on registry.agents.agent(id).deploy's
 * returned DeploymentHandle; this is only "what deployments do I have,"
 * for dashboard views that join against published agents by agentId.
 */
export function Deployments(opts: DeploymentsOpts) {
    return {
        async list(): Promise<DeploymentRecord[]> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/user/deployments")
            return rows(raw.deployments, "deployments").map(parseDeploymentRecord)
        },
    }
}

export type DeploymentsHandle = ReturnType<typeof Deployments>
