import { KINDS, type ProjectKind } from "../kinds"
import { Frame } from "../../frame"
import { Agent } from "./agent"
import { Artifacts } from "./artifacts"
import { Module } from "./module"
import { Source } from "./source"
import { Stage } from "./stage"
import type { ManifestT } from "../manifest"
import type { SourceModulesT } from "../modules"
import type { BundleArtifact, BundleIdentity, BundleImage, SourceImage } from "./types"

type BundleOpts = {
    root: string
    /** The project's declaration files — where a bundle's identity comes from. */
    manifest: ManifestT
    /** Local source modules — staged into an agent bundle with their imports rebased. */
    modules: SourceModulesT
    /**
     * Bring the project's dependencies up to date before packaging it.
     *
     * A GETTER because Prepare() is constructed after Bundle() and needs it —
     * resolving at call time rather than construction time breaks the cycle
     * without reordering the composition root.
     */
    prepare: () => () => Promise<unknown>
}

/**
 * Bundle — package a project into its publishable artifact.
 *
 * Agent  → .agent/build/image.json + source.tar.gz                    (deploy upload)
 * Module → .module/build/image.json + manifest.json + source.tar.gz   (registry publish)
 * Source → .<kind>/build/image.json + source.tar.gz                   (cognet, bench, prompt)
 *
 * Which bundler runs is read from the kind table's `bundle` field, not
 * branched on here — the same table every other per-kind decision reads. It
 * used to be an `if (kind === "agent") … if (kind === "module") …` chain
 * duplicated across project.ts and publish.ts, which is exactly the shape
 * kinds.ts exists to prevent.
 *
 * Metadata comes from package.json (canonical name/version) and, for agents,
 * from the evaluated config via Config() — the old regex-parsing of
 * axon.config.ts is gone; a config too broken to evaluate is too broken to ship.
 *
 * ONE verb: build(). It returns the artifact — identity, directory and tarball
 * together — because the directory only means anything once the build that
 * filled it has run. Handing out a path separately made that ordering
 * load-bearing and invisible: a caller that read the path before building
 * uploaded whatever the last build left there, silently. A value cannot be
 * obtained before the work that produces it, so the hazard is gone rather than
 * documented.
 */
export function Bundle(opts: BundleOpts) {
    const root = opts.root

    const artifacts = Artifacts({ root: root, manifest: opts.manifest })
    const stage = Stage({ root: root })

    const agent = Agent({ root: root, artifacts: artifacts, stage: stage, modules: opts.modules })
    const module = Module({ root: root, artifacts: artifacts, stage: stage })
    const source = Source({ root: root, artifacts: artifacts, stage: stage })

    async function run(kind: ProjectKind): Promise<BundleArtifact> {
        // Prepare first, unconditionally.
        //
        // `build`, `publish` and `deploy` all arrive here, and none of them
        // prepared — only `dev`/`run` did, through RunningAgent. So an agent
        // that had never been run could not be built: its cognet is declared
        // (or defaulted to @axon/zero) but was never installed, and packaging
        // failed with COGNET_NOT_FOUND naming a node_modules tree nobody had
        // populated. On `deploy` that surfaced after provisioning was paid for.
        //
        // Idempotent, so the cost when everything is current is a few reads.
        await opts.prepare()()

        const via = KINDS[kind].bundle
        const dir = Frame({ root: root, kind: kind }).path("build")

        const result = via === "agent"
            ? await agent.build()
            : via === "module"
                ? await module.build()
                : await source.build(kind as SourceImage["kind"])

        return {
            image: result.image,
            identity: identityOf(result.image),
            dir,
            tarball: result.tarball,
            // Absent for agent and module bundles, which have no README to
            // illustrate — a real "this kind carries none", not a masked null.
            assets: result.assets ?? [],
            assetsTarball: result.assetsTarball ?? null,
        }
    }

    return {
        /**
         * Package this project and return the artifact.
         *
         * Always rebuilds. A bundle is a projection of the whole source tree,
         * and nothing here is watching it — an earlier version of this cached
         * on the package.json version, which served a stale tarball to anyone
         * who edited a source file without bumping (caught by "re-bundling
         * replaces the previous .agent bundle"). Detecting that properly means
         * hashing the tree including node_modules, which costs more than the
         * rebuild it would save.
         *
         * Callers that need the artifact at several points in ONE operation
         * should hold the value rather than calling again — see session().
         */
        build: run,

        /**
         * A bundling session for one publish/deploy: builds at most once,
         * unless something invalidates the artifact.
         *
         * Publish needs the identity to register and the directory to upload,
         * and on a version collision must rebuild after bumping the patch —
         * three touch points, one build. `rebuild()` is explicit rather than
         * inferred, because the ONE thing that legitimately invalidates a
         * bundle mid-operation is a caller that just rewrote package.json and
         * knows it.
         */
        session(kind: ProjectKind) {
            let artifact: BundleArtifact | null = null

            return {
                /** The artifact, built on first call and reused thereafter. */
                async current(): Promise<BundleArtifact> {
                    artifact ??= await run(kind)
                    return artifact
                },

                /** Discard and rebuild — call after mutating package.json. */
                async rebuild(): Promise<BundleArtifact> {
                    artifact = await run(kind)
                    return artifact
                },
            }
        },
    }
}

export type BundleT = ReturnType<typeof Bundle>

/**
 * Every image spells its name differently (agentId / moduleId / name). Callers
 * register against one identity and care about none of that, so the difference
 * is normalised here — a new kind adds a bundler and nothing else.
 */
function identityOf(image: BundleImage): BundleIdentity {
    const name = "agentId" in image ? image.agentId : "moduleId" in image ? image.moduleId : image.name
    return {
        name,
        version: image.version,
        public: image.public,
        ...(image.description !== undefined ? { description: image.description } : {}),
    }
}
