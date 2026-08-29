import type { ArtifactRecord, ArtifactStats, ArtifactVersion } from "../artifacts/types"

export type DeployTier = "nano" | "small" | "medium" | "large"
export type DeployWarmth = "on-demand" | "always-on"
export type DiskAddOn = "standard" | "large"

/**
 * An agent IS a registry artifact — same row, same routes, same parsing. What
 * makes an agent distinct is that it RUNS, which is the deployment vocabulary
 * below, not its registry record.
 *
 * These aliases keep agent-facing consumers reading naturally without a second
 * definition of the same shape. The parallel `AgentRecord` that used to live
 * here carried `agentId` where the artifact carries `artifactId`, so every
 * agent screen re-parsed identical JSON into a differently-named object.
 *
 * `AgentStats` previously also carried `activeDeployments`, served only by the
 * retired `/api/agents/:id/stats` route and read by nothing — the dashboard
 * takes that count from `user.overview()`, which is account-wide and still
 * does. Dropped rather than carried forward into the shared shape.
 */
export type AgentRecord = ArtifactRecord
export type AgentVersion = ArtifactVersion
export type AgentStats = ArtifactStats

export type DeploymentRecord = {
    id: string
    agentId: string
    /**
     * The agent's registry name, e.g. "@cody/dave" — joined server-side because
     * the row itself only knows the agentId UUID, and every consumer that shows
     * a deployment needs the name. Null only for a row whose agent was deleted.
     */
    agentName: string | null
    tier: string
    warmth: string
    status: string
    url: string | null
    createdAt: string
    /** Set when status is "error" — the reason, surfaced loudly, never hidden. */
    lastError: string | null
    axonBaseVersion: string | null
}

export type DeploymentStatus = {
    status: "provisioning" | "starting" | "running" | "stopped" | "error" | string
    url?: string
    /**
     * Why the deployment is in `error`. The control plane records a real reason
     * (an insufficient-funds marker, or the provisioning failure verbatim) — it
     * was previously dropped on the way out, so a failed deploy reported a UUID
     * and nothing else for something the user is paying for.
     */
    lastError?: string | null
}

export type DeployOptions = {
    tier?: DeployTier
    warmth?: DeployWarmth
    diskAddOn?: DiskAddOn | null
    /** Production environment values. Transported to deployment secrets; never included in registry artifacts. */
    env?: Record<string, string>
}

/** Steps surfaced through onProgress during the composed deploy flow. */
export type DeployStep =
    /** Building the artifact — before the cloud is touched at all. */
    | { step: "bundling" }
    /** An immutable-version collision sent the flow back to rebuild. */
    | { step: "bumped"; from: string; to: string }
    /** Claiming the name in the registry — where an ownership failure lands. */
    | { step: "registering"; name: string }
    | { step: "publishing"; agentId: string }
    | { step: "provisioning"; agentId: string }
    | { step: "starting"; deploymentId: string }
    | { step: "ready"; deploymentId: string; url: string }

/**
 * Provisioning was rejected because the balance can't cover the commitment.
 * Carries everything the caller needs to resolve it — deficit and a Stripe
 * checkout URL when the backend could mint one.
 */
/**
 * A deployment that will never become ready, with the reason and enough context
 * to act on it.
 *
 * The previous failure path threw `deployment <uuid> entered error state` — a
 * UUID and nothing else, for something the user is paying for. Every field here
 * exists so a terminal can render an actionable message without a second call:
 * `reason` is the control plane's recorded cause, `logs` is the tail the
 * container actually produced (usually the real story), and `phase` says which
 * stage of the journey broke.
 */
export class DeploymentFailedError extends Error {
    deploymentId: string
    /** Where it broke — provisioning never completed, or the container never became healthy. */
    phase: "provisioning" | "starting" | "timeout"
    /** The control plane's recorded cause, when it has one. */
    reason: string | null
    /** Tail of the container's own output. Empty when nothing was logged or logs were unreachable. */
    logs: Array<{ timestamp: string; severity: string; message: string }>

    constructor(details: {
        deploymentId: string
        phase: "provisioning" | "starting" | "timeout"
        reason: string | null
        logs?: Array<{ timestamp: string; severity: string; message: string }>
    }) {
        super(DeploymentFailedError.describe(details))
        this.name = "DeploymentFailedError"
        this.deploymentId = details.deploymentId
        this.phase = details.phase
        this.reason = details.reason
        this.logs = details.logs ?? []
    }

    /**
     * One line that names the phase and the cause. The log tail is deliberately
     * NOT in the message — a caller renders it separately so a terminal can dim
     * it, and a message is not the place for twenty lines of container output.
     */
    private static describe(details: { deploymentId: string; phase: string; reason: string | null }): string {
        const where = details.phase === "timeout" ? "did not become ready in time" : `failed while ${details.phase}`
        return details.reason
            ? `deployment ${where}: ${details.reason}`
            : `deployment ${where} (no reason recorded — check logs)`
    }
}

export class InsufficientFundsError extends Error {
    deficitMinor: number
    availableMinor: number
    requiredMinor: number
    checkoutUrl: string | null

    constructor(details: { deficitMinor: number; availableMinor: number; requiredMinor: number; checkoutUrl: string | null }) {
        super(`insufficient balance to deploy: need ${details.requiredMinor} minor units, have ${details.availableMinor}`)
        this.deficitMinor = details.deficitMinor
        this.availableMinor = details.availableMinor
        this.requiredMinor = details.requiredMinor
        this.checkoutUrl = details.checkoutUrl
    }
}
