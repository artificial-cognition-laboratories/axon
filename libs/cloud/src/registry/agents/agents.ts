import { HttpError, PROVISION_TIMEOUT_MS } from "../../platform/http"
import type { HttpClient } from "../../platform/http"
import { num, record, str } from "../../platform/parse"
import { Artifact } from "../artifacts/artifact"
import type { ArtifactHandle } from "../artifacts/artifact"
import { Deployment } from "./deployment"
import type { DeploymentHandle } from "./deployment"
import { InsufficientFundsError } from "./types"
import type { DeployOptions, DeployStep } from "./types"

type AgentsOpts = {
    http: HttpClient
    runtime: "node" | "browser"
}

type DeployInput = DeployOptions & {
    /** Bundle path — the axon build output directory, or a .tar.gz beside its image.json. */
    path: string
    /** Agent name in the registry — created (idempotently) if it doesn't exist. */
    name: string
    onProgress?: (step: DeployStep) => void
    timeoutMs?: number
    signal?: AbortSignal
}

/**
 * An agent handle: everything an artifact is, plus the one thing only an agent
 * has. Agents are the sole kind that RUNS, so deployment is the whole of what
 * makes this type distinct.
 */
export type AgentHandle = ArtifactHandle & {
    /** Scoped handle for a known deployment id (e.g. straight from deploy()). */
    deployment(deploymentId: string): DeploymentHandle
}

/**
 * Agents — deployment, and nothing else.
 *
 * The registry half of "agents" is `registry.artifacts.of("agent")`: an agent
 * is a registry artifact like any other, and its record, versions, publishing,
 * stars and stats are served by the same routes and parsed by the same code as
 * every other kind. This module used to restate all of it against a parallel
 * `/api/agents/*` route family — one endpoint per verb, duplicating what
 * `/api/artifacts/*` already did over the same rows. That duplication is what
 * let an agent-bound key reach a sibling agent through the artifacts path
 * while the agents path refused it: two doors, one of them unguarded.
 *
 * So what remains is what genuinely has no artifact equivalent — provisioning
 * compute and the deployment lifecycle. `deploy()` is the crown verb: the
 * composed flow (register → publish → provision → wait ready) built from the
 * same primitives exposed individually, behaving identically from the TUI, CI,
 * or a script. Callers only render progress.
 */
export function Agents(opts: AgentsOpts) {
    /**
     * The artifact handle, widened with deployment. Composition rather than a
     * parallel implementation: every registry verb is the artifact's, so there
     * is exactly one place where publishing or starring an agent is written.
     */
    function agent(id: string): AgentHandle {
        return {
            ...Artifact({ id, http: opts.http, runtime: opts.runtime, kind: "agent" }),
            deployment(deploymentId: string): DeploymentHandle {
                return Deployment({ id: deploymentId, http: opts.http })
            },
        }
    }

    /** Register (idempotent — backend returns the existing record for a known name). */
    async function create(input: { name: string; description?: string; private?: boolean }): Promise<AgentHandle> {
        const raw = record(await opts.http.post("/api/user/artifacts", { ...input, kind: "agent" }), "agent")
        return agent(str(raw, "artifactId"))
    }

    async function provision(agentId: string, options: DeployOptions): Promise<{ deploymentId: string }> {
        try {
            // Provisioning builds a Cloud Run service while this request is
            // open — routinely 60–120s, well past the control-plane budget.
            // On the 30s default the CLI reported a timeout for deployments
            // that were still succeeding: the service came up and the
            // commitment was billed, and the user was told it failed.
            const raw = record(await opts.http.post("/api/user/deployments", {
                agentId,
                tier: options.tier ?? "small",
                warmth: options.warmth ?? "on-demand",
                ...(options.diskAddOn !== undefined ? { diskAddOn: options.diskAddOn } : {}),
                env: options.env ?? {},
            }, undefined, PROVISION_TIMEOUT_MS), "provision result")
            return { deploymentId: str(raw, "deploymentId") }
        } catch (error) {
            if (error instanceof HttpError && error.status === 402 && error.data) {
                throw new InsufficientFundsError({
                    deficitMinor: num(error.data, "deficitMinor"),
                    availableMinor: num(error.data, "availableMinor"),
                    requiredMinor: num(error.data, "requiredMinor"),
                    checkoutUrl: typeof error.data.checkoutUrl === "string" ? error.data.checkoutUrl : null,
                })
            }
            throw error
        }
    }

    return {
        agent: agent,
        create: create,

        /**
         * Name (or id) → an agent handle, no published version required.
         *
         * `artifacts.handle()` answers the same lookup but hands back a plain
         * artifact, which cannot reach deployment. A caller holding a name and
         * wanting to deploy would otherwise resolve through one surface and
         * re-wrap through this one.
         */
        async handle(nameOrId: string): Promise<AgentHandle> {
            const raw = record(
                await opts.http.get(`/api/registry/resolve-id?name=${encodeURIComponent(nameOrId)}`),
                "resolved agent id",
            )
            return agent(str(raw, "artifactId"))
        },

        /**
         * The crown verb: bundle path → running agent.
         *
         * register (idempotent) → publish → provision (throws
         * InsufficientFundsError with a checkout URL when the balance can't
         * cover the commitment) → wait until running.
         */
        async deploy(input: DeployInput): Promise<{ agent: AgentHandle; deployment: DeploymentHandle; url: string }> {
            // Reported BEFORE create(), not after. Claiming the name is where
            // an ownership failure lands (a 403 for a scope you do not own),
            // and reporting it afterwards meant that failure appeared to
            // happen during whatever step was last announced — the bundle.
            input.onProgress?.({ step: "registering", name: input.name })
            const target = await create({ name: input.name })

            input.onProgress?.({ step: "publishing", agentId: target.id })
            // requireImage: an agent bundle without its build manifest is not
            // deployable, and this is the path that produces one.
            await target.publish({ path: input.path, requireImage: true })

            input.onProgress?.({ step: "provisioning", agentId: target.id })
            const { deploymentId } = await provision(target.id, input)

            const deployment = Deployment({ id: deploymentId, http: opts.http })

            input.onProgress?.({ step: "starting", deploymentId })
            const { url } = await deployment.waitUntilReady({
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
            })

            input.onProgress?.({ step: "ready", deploymentId, url })
            return { agent: target, deployment, url }
        },
    }
}

export type AgentsHandle = ReturnType<typeof Agents>
