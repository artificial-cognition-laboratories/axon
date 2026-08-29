import { HttpError } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import type { ArtifactKind, AxonCloudClient } from "@arcforge/cloud"
import type { AssetReport, BundleT } from "./bundle"
import { KINDS, type ProjectKind } from "./kinds"
import type { ManifestT } from "./manifest"
import { verifyArtifact } from "./publish/verify"

export type PublishResult = {
    /** package.json name — what the user calls it */
    name: string
    /** registry id the backend assigned */
    registeredId: string
    /** version actually published — patch-bumped when the local version already exists */
    version: string
    public: boolean
    /**
     * README assets that shipped, for the CLI's report. Empty for kinds that
     * carry none — an author who compressed 3MB of screenshots into 800KB
     * should see that happen rather than infer it.
     */
    assets: AssetReport[]
}

/**
 * Steps surfaced through onProgress during publish.
 *
 * A discriminated union rather than a string so a step can carry the one fact
 * that makes it meaningful — which version collided, how big the upload is —
 * matching how DeployStep already reports the deploy flow.
 *
 * `bumped` is the reason this is not simply a linear sequence. A published
 * version is immutable, so a 409 sends the flow back through bump → rebuild →
 * verify, and a renderer that assumed forward-only progress would either
 * freeze or silently redo completed steps. Emitting the retry makes the loop
 * something the user watches rather than something they infer from a pause.
 */
export type PublishStep =
    | { step: "bundling" }
    | { step: "verifying" }
    | { step: "registering"; name: string }
    | { step: "uploading"; version: string }
    | { step: "bumped"; from: string; to: string }
    | { step: "published"; version: string }

type PublishOpts = {
    kind: ProjectKind
    /** Project root — verification resolves the installed runtime from here. */
    root: string
    bundle: BundleT
    manifest: ManifestT
    cloud: AxonCloudClient
}


/**
 * Narrows a ProjectKind to what the registry accepts.
 *
 * A predicate rather than a bare boolean check so the narrowing is real:
 * `ArtifactKind` is the BACKEND's contract (a Postgres enum), and the two
 * unions diverging is the whole point — a kind the registry has never heard of
 * must not reach `artifacts.create()`. Casting past this would turn a compile
 * error into a runtime 4xx, which is the trade this guard exists to refuse.
 */
function isPublishable(kind: ProjectKind): kind is ArtifactKind {
    return KINDS[kind].publishable
}

/**
 * Publish — bundle, register (idempotent), upload, sync visibility.
 * Uploads only — provisioning/starting compute is deploy's job (Agents.deploy).
 *
 * ONE path for all four kinds. It used to fork on `kind === "agent"` with
 * everything else falling through to the module branch, which silently
 * registered a cognet in the modules table and claimed its name in the shared
 * namespace as the wrong kind. Now the kind is data: it selects a bundler and
 * is sent to the backend, and nothing else about publishing differs.
 *
 * Published versions are immutable. A collision (backend 409) auto-bumps the
 * patch in package.json, rebuilds so the tarball and registry metadata agree,
 * and retries.
 *
 * Auth failures (401) and username-required (403) propagate as HttpError —
 * the caller owns how to present them.
 */
export function Publish(opts: PublishOpts) {
    const { kind, bundle, manifest, cloud } = opts

    return async function publish(
        options: { onProgress?: (step: PublishStep) => void } = {},
    ): Promise<PublishResult> {
        // Absent by default so every existing caller is unchanged and a
        // consumer that wants no progress pays nothing for the option.
        const report = options.onProgress ?? (() => {})

        // Before anything is built. Failing here costs a bundle nobody wanted,
        // rather than a confusing API error after one was produced.
        if (!isPublishable(kind)) throw err("PUBLISH_UNSUPPORTED_KIND", { context: { kind } })

        report({ step: "bundling" })
        const session = bundle.session(kind)
        let artifact = await session.current()

        // Before ANY registry mutation. A published version is immutable, so
        // an artifact that cannot be compiled is not a bug to fix later — it
        // is a permanent one, already resolving for anyone who asks. The last
        // cheap moment is here.
        report({ step: "verifying" })
        await verifyArtifact({ kind, tarball: artifact.tarball, root: opts.root, name: artifact.identity.name })

        report({ step: "registering", name: artifact.identity.name })
        const handle = await cloud.registry.artifacts.create({
            kind,
            name: artifact.identity.name,
            ...(artifact.identity.description !== undefined ? { description: artifact.identity.description } : {}),
            private: !artifact.identity.public,
        })

        let version: string
        while (true) {
            try {
                report({ step: "uploading", version: artifact.identity.version })
                ; ({ version } = await handle.publish({ path: artifact.dir }))
                break
            } catch (error) {
                if (!(error instanceof HttpError) || error.status !== 409) throw error
                // The bump rewrites package.json, so the built artifact now
                // carries the wrong version — rebuild before retrying, or the
                // tarball ships the old metadata under the new number.
                const from = artifact.identity.version
                await manifest.package.bump(from)
                artifact = await session.rebuild()
                report({ step: "bumped", from, to: artifact.identity.version })
                // The rebuild is a different tarball, so it earns its own
                // check — a bump must not be a way around the gate. Reported
                // again because it is a real second verification: leaving the
                // display on "bumped" would attribute its duration to a step
                // that already finished.
                report({ step: "verifying" })
                await verifyArtifact({ kind, tarball: artifact.tarball, root: opts.root, name: artifact.identity.name })
            }
        }

        await handle.update({ private: !artifact.identity.public })
        report({ step: "published", version })

        return {
            name: artifact.identity.name,
            registeredId: handle.id,
            version,
            public: artifact.identity.public,
            assets: artifact.assets,
        }
    }
}
