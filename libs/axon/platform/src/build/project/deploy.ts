import { HttpError } from "@arcforge/cloud"
import type { AxonCloudClient, DeploymentHandle, DeployOptions, DeployStep } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import type { BundleT } from "./bundle"
import type { ManifestT } from "./manifest"

export type DeployResult = {
    name: string
    registeredId: string
    url: string
    /** Handle to the deployment just created — stop/redeploy/delete/secrets. */
    deployment: DeploymentHandle
}

type DeployOpts = {
    bundle: BundleT
    manifest: ManifestT
    cloud: AxonCloudClient
}

/**
 * Deploy — provision running compute for an agent. Agents only: modules
 * never run alone (see Project.deploy's caller — module kind throws
 * before this is reached).
 *
 * Delegates to Agents.deploy(), the registry's crown verb: register
 * (idempotent) → publish → provision → wait until running. On an immutable
 * version collision, advances the project's patch version, rebuilds, and
 * resumes the composed flow instead of making deploy a manual two-step.
 */
export function Deploy(opts: DeployOpts) {
    const { bundle, manifest, cloud } = opts

    return async function deploy(options: DeployOptions & { onProgress?: (step: DeployStep) => void } = {}): Promise<DeployResult> {
        // Referenced explicitly rather than relied on through the `...options`
        // spread below. It reached the cloud client by name collision — both
        // sides happen to call the field `onProgress` — so renaming either
        // would have silently stopped every deploy reporting progress, with no
        // type error anywhere.
        const report = options.onProgress ?? (() => {})

        const env = await manifest.env.production()

        // The bundle completes before the cloud is touched at all, so it is a
        // step the caller can render honestly. Without it a failure during
        // publish marks the bundle as the thing that failed.
        report({ step: "bundling" })
        const session = bundle.session("agent")
        let artifact = await session.current()

        while (true) {
            try {
                const { agent, deployment, url } = await cloud.registry.agents.deploy({
                    path: artifact.dir,
                    name: artifact.identity.name,
                    ...options,
                    env,
                })

                return { name: artifact.identity.name, registeredId: agent.id, url, deployment }
            } catch (error) {
                if (!(error instanceof HttpError) || error.status !== 409) {
                    if (error instanceof HttpError && error.data?.code === "DEPLOY_RUNTIME_FAILED") {
                        const reason = typeof error.data.reason === "string" ? error.data.reason : "RevisionFailed"
                        const detail = typeof error.data.detail === "string" ? error.data.detail : error.message
                        throw err("DEPLOY_RUNTIME_FAILED", {
                            detail,
                            context: { reason },
                            cause: error,
                        })
                    }
                    if (error instanceof HttpError && error.status >= 500) {
                        const requestId = typeof error.data?.requestId === "string"
                            ? error.data.requestId
                            : "unavailable"
                        throw err("DEPLOY_PROVISION_FAILED", {
                            detail: `Cloud request failed with status ${error.status} (request ID: ${requestId})`,
                            context: { status: error.status, path: error.path, requestId },
                            cause: error,
                        })
                    }
                    throw error
                }
                const from = artifact.identity.version
                await manifest.package.bump(from)
                artifact = await session.rebuild()
                // The retry re-bundles, so the caller's step list has to
                // re-open rather than appearing frozen mid-publish.
                report({ step: "bumped", from, to: artifact.identity.version })
                report({ step: "bundling" })
            }
        }
    }
}

export type DeployT = ReturnType<typeof Deploy>
