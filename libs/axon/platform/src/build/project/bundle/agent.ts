import { dirname, join, relative, resolve, sep } from "node:path"
import { cp, mkdir, rm } from "node:fs/promises"
import { axonBaseRef, type AxonConfig } from "@arcforge/types"
import { err } from "@arcforge/err"
import { Config, flatten } from "../../blueprint"
import { Cognet, cognetSourceOf } from "../../blueprint"
import { fsx } from "../../../utils/fs"
import { Frame, BUNDLE_COGNET_DIR, type FrameT } from "../../frame"
import { INLINE_COGNET_DIR } from "../../blueprint/cognet"
import type { SourceModulesT } from "../modules"
import { assertConfigContained } from "./imports"
import { Assets } from "./assets"
import type { ArtifactsT } from "./artifacts"
import type { StageT } from "./stage"
import type { AgentImage, BundleResult } from "./types"

/** Config keys the bundle reads that aren't part of the core authoring type yet. */
type PublishableConfig = AxonConfig & {
    connections?: Record<string, unknown>
}

type AgentOpts = {
    root: string
    artifacts: ArtifactsT
    stage: StageT
    modules: SourceModulesT
}

/**
 * Agent bundle — .agent/build/image.json + source.tar.gz, the deploy upload.
 *
 * Unlike every other kind, an agent ships PRE-BUILT: its executable brain is
 * compiled in, its local source modules are staged and their imports rebased,
 * and its resolved node_modules ride along because the deploy target boots the
 * extracted tarball directly and never runs an install.
 *
 * NOTE the two layouts in play. Locally the bundle's own outputs live in the
 * frame's `build/` area, while the compiled brain lives in `cognet/` — they
 * are siblings, written by different stages. INSIDE the tarball the brain
 * sits at `.agent/cognet/`, which is a wire contract: `stageCognet()` writes
 * that path into the shipped manifest and a deployed container resolves the
 * brain through it. So the staging step below is a deliberate REMAP, not a
 * copy of the local layout, and the two must be allowed to differ.
 */
export function Agent(opts: AgentOpts) {
    const { root, artifacts, stage, modules } = opts
    const frame = Frame({ root: root, kind: "agent" })

    return {
        async build(): Promise<BundleResult> {
            const loaded = await Config(root)

            // Before anything is compiled or staged. A config that reaches
            // outside the project cannot be published, and finding that out
            // after a bundle exists costs a build nobody wanted — finding it
            // out in a container costs a provisioned deployment.
            //
            // Runs after Config() only so the DECLARED source modules are
            // known: those legitimately live outside the root and are staged in
            // with their imports rebased, so they are the one escape that is
            // not one. Still before any compile or stage, which is what the
            // "fail cheaply" reasoning above actually requires.
            await assertConfigContained(root, join(root, "axon.config.ts"), (
                await flatten(loaded.modules, loaded.modulePaths)
            ).flatMap(entry => (entry.kind === "source" ? [entry.configPath] : [])))
            const config = loaded.value as PublishableConfig
            const pkg = await artifacts.identity()

            // Clears assets ONLY. Unlike the other bundlers this must not clear
            // its own outputs wholesale — `.agent/build` holds the cognet cache
            // that the compile below reuses, and wiping it would recompile the
            // brain on every publish. These two entries are named because a
            // deleted asset has no other signal that it should be gone.
            const bundleDir = await artifacts.open(frame.path("build"), [
                "assets.tar.gz",
                ".assets",
            ])

            // A publishable agent includes its executable brain. Preserve the
            // .agent/cognet cache across bundles, then compile/update it from
            // the selected source cognet before assembling the artifact.
            await Cognet({ root: root }).compile(cognetSourceOf(loaded))

            const image: AgentImage = {
                kind: "agent",
                agentId: pkg.name,
                version: pkg.version,
                // package.json is the one visibility contract for agents and
                // modules: private:true stays private; absent/false publishes.
                public: pkg.public,
                // Registry description comes from package.json — same source as modules.
                ...(pkg.description ? { description: pkg.description } : {}),
                axonVersion: "0.1.0",
                builtAt: new Date().toISOString(),
                ...(config.connections ? { connections: config.connections } : {}),
            }
            await artifacts.image(bundleDir, image)

            // Groundwork for self-hosting — AxonCloud deploys never build this
            // Dockerfile (source loads onto an already-established shared image),
            // but the bundle ships one so anyone self-hosting can `docker build`
            // it themselves without us needing to invoke Docker on their behalf.
            await Bun.write(join(bundleDir, "Dockerfile"), dockerfile())
            await Bun.write(join(bundleDir, ".dockerignore"), DOCKERIGNORE)

            const tarball = join(bundleDir, "source.tar.gz")
            const stageDir = join(bundleDir, ".stage")
            try {
                await mkdir(stageDir, { recursive: true })
                await copyTree(root, stageDir)
                await stageSourceModules(root, stageDir, loaded, modules)
                await stageCognet(frame, bundleDir, stageDir)

                // `data/knowledge/` and nothing else under data/: knowledge is
                // authored material that defines what the agent knows, while
                // workspace/ is scratch and modules/ is module-managed runtime
                // state — neither belongs to anyone but this one installation.
                // The published-files table in the docs has always said
                // `data/knowledge/ ✓ included`; this is what makes that true.
                const entries = ["src", "server", "modules", INLINE_COGNET_DIR, join("data", "knowledge")]
                    .filter(dir => fsx.exists(join(stageDir, dir)))
                // Tarball-relative, matching what stageCognet() laid down.
                entries.push(
                    "axon.config.ts",
                    "package.json",
                    `${frame.name}/Dockerfile`,
                    `${frame.name}/.dockerignore`,
                    `${frame.name}/${BUNDLE_COGNET_DIR}`,
                )
                // The lockfile is what makes the consumer's install the SAME
                // install: without it `bun install` re-resolves every range and
                // the agent that ships is not the agent that was tested.
                if (fsx.exists(join(stageDir, "bun.lock"))) entries.push("bun.lock")
                if (fsx.exists(join(stageDir, "bunfig.toml"))) entries.push("bunfig.toml")
                if (fsx.exists(join(stageDir, "README.md"))) entries.push("README.md")

                await stage.tar(stageDir, tarball, entries)
            } finally {
                await rm(stageDir, { recursive: true, force: true })
            }

            // README assets — their own tarball, never a member of the deploy
            // one. `copyTree` above only takes named source directories, so
            // `assets/` was never IN this tarball; what was missing was the
            // separate archive, which meant an agent's screenshots and demo
            // video silently never reached storage. To their author that reads
            // as a broken registry page rather than as a missing upload.
            //
            // Every publishable kind has a registry page, so every publishable
            // kind carries assets. This was wired into the source bundler first
            // and agents and modules were left behind.
            const assets = await Assets({ root, stage }).collect(bundleDir)

            return {
                image,
                tarball,
                assets: assets.assets,
                ...(assets.tarball ? { assetsTarball: assets.tarball } : {}),
            }
        },
    }
}

export type AgentBundleT = ReturnType<typeof Agent>

// ─── Staging ──────────────────────────────────────────────────────────────────

/**
 * Copy the agent's own source and manifests into the stage.
 *
 * Dependencies are DECLARED, not shipped. package.json plus bun.lock is the
 * whole dependency statement, and `bun install` at prepare time (local) or
 * image build time (deploy) materializes it — the same split every other
 * project kind already used, and the same one Installer describes: Axon
 * decides what the agent has, Bun decides how those bytes arrive.
 *
 * This used to stage a dereferenced copy of the resolved node_modules, on the
 * grounds that the deploy target boots the extracted tarball and never runs an
 * install. That constraint is real but belongs to DEPLOY, and publish shares
 * this bundler — so an artifact destined for a machine that can obviously
 * install still carried every byte. For an agent with native dependencies that
 * is fatal rather than wasteful: vox declares onnxruntime and kokoro, whose
 * prebuilds for every platform total ~354MB against a 50MB registry limit, so
 * the agent could not be published at all. Shipping source also removes the
 * publisher's machine from the result — a materialized tree bakes in whichever
 * platform's natives that machine resolved.
 */
async function copyTree(root: string, stageDir: string): Promise<void> {
    // `cognet` is here because an INLINE brain is the agent's own source, and
    // the most load-bearing source it has. The compiled bundle ships too (see
    // stageCognet) and is what actually runs, but shipping only that would
    // publish an agent whose thinking is an opaque .mjs — unreadable in the
    // registry's source view and uneditable by anyone who clones it. An agent
    // with a registry cognet simply has no such directory, so this is a
    // no-op there.
    for (const dir of ["src", "server", "modules", INLINE_COGNET_DIR]) {
        const source = join(root, dir)
        if (fsx.exists(source)) await cp(source, join(stageDir, dir), { recursive: true })
    }

    // The inline cognet's tsconfig.json is a generated pointer into THIS
    // machine's frame (`../.agent/types/cognet.tsconfig.json`) — prepare
    // rewrites it for whoever clones the agent, and shipping it means
    // publishing a path that resolves to nothing until they do. The source
    // bundler drops tsconfig.json for exactly this reason; the rule is the
    // same here, it just has to be applied after the recursive copy.
    await rm(join(stageDir, INLINE_COGNET_DIR, "tsconfig.json"), { force: true })

    // bun.lock pins what install resolves; bunfig.toml carries the @axon scope →
    // registry mapping, without which a consumer's install cannot resolve an
    // Axon module at all.
    for (const file of ["package.json", "README.md", "bun.lock", "bunfig.toml"]) {
        const source = join(root, file)
        if (fsx.exists(source)) await cp(source, join(stageDir, file))
    }
}

/**
 * Stage local source modules and rebase every import that reaches them.
 *
 * Registry modules need no handling: they are ordinary packages in the
 * node_modules copied above. Only source modules — which live outside the
 * agent root — must be copied in and have their config imports rewritten.
 */
async function stageSourceModules(
    root: string,
    stageDir: string,
    loaded: Awaited<ReturnType<typeof Config>>,
    modules: SourceModulesT,
): Promise<void> {
    const configTargets = new Map<string, string>()
    const sourceConfigs: Array<{ source: string; target: string }> = []
    const claimedNames = new Set<string>()

    for (const entry of await flatten(loaded.modules, loaded.modulePaths)) {
        if (entry.kind !== "source") continue
        const module = await modules.resolve(entry.configPath)
        const dest = join(stageDir, "modules", module.name)
        if (claimedNames.has(module.name) || fsx.exists(join(root, "modules", module.name))) {
            throw err("BUNDLE_MODULE_COLLISION", {
                detail: `source module "${module.name}" collides with an installed module at modules/${module.name}`,
                context: { moduleName: module.name },
            })
        }
        claimedNames.add(module.name)
        await mkdir(join(stageDir, "modules"), { recursive: true })
        await cp(module.root, dest, { recursive: true })

        const source = resolve(entry.configPath)
        const target = join(dest, "module.config.ts")
        configTargets.set(source, target)
        sourceConfigs.push({ source, target })
    }

    const sourceAgentConfig = join(root, "axon.config.ts")
    const targetAgentConfig = join(stageDir, "axon.config.ts")
    const agentConfig = await fsx.readText(sourceAgentConfig)
    if (agentConfig === null) throw err("CONFIG_NOT_FOUND", { context: { root } })
    await Bun.write(
        targetAgentConfig,
        rebaseImports(agentConfig, sourceAgentConfig, targetAgentConfig, configTargets),
    )

    // Source modules can themselves hard-import other source modules. Rebase
    // those config files too, relative to their flattened staged locations, so
    // the whole declared graph remains self-contained.
    for (const config of sourceConfigs) {
        const text = await fsx.readText(config.source)
        if (text === null) continue
        await Bun.write(config.target, rebaseImports(text, config.source, config.target, configTargets))
    }
}

/**
 * Copy the compiled brain into the stage, stripped of build scratch.
 *
 * The REMAP from local layout to tarball layout (see this file's header).
 * Locally the Dockerfile comes out of the frame's `build/` area and the brain
 * out of its `cognet/` area; inside the tarball both sit under `.agent/`,
 * because that is the path a deployed container resolves and it cannot move
 * without breaking agents already in production.
 */
async function stageCognet(frame: FrameT, bundleDir: string, stageDir: string): Promise<void> {
    const shipped = join(stageDir, frame.name)
    await mkdir(shipped, { recursive: true })
    await cp(join(bundleDir, "Dockerfile"), join(shipped, "Dockerfile"))
    await cp(join(bundleDir, ".dockerignore"), join(shipped, ".dockerignore"))

    const target = join(shipped, BUNDLE_COGNET_DIR)
    await cp(frame.path("cognet"), target, { recursive: true })

    // Strip everything the compile step scratches into the cognet dir.
    //
    // `.build` is the bundler's own workspace. `.instances` is per-RUNTIME
    // scratch: core copies the compiled cognet to a unique physical path per
    // booted agent (module scope is one brain's resident RAM, so two runtimes
    // must not share a module instance) and removes it on dispose. A `kill -9`
    // skips that dispose, so a developer's crashed local runs leave copies
    // behind — and they were being published.
    //
    // Shipping them is not cosmetic: each is a multi-hundred-KB duplicate of a
    // file already in the tarball, named with a hash and a UUID from the
    // publisher's machine, and long enough (130 chars) that GNU tar emits a
    // `@LongLink` pseudo-entry for it — which is what surfaced in the
    // registry's file tree as unexplained `@LongLink` rows.
    for (const scratch of [".build", ".instances"]) {
        await rm(join(target, scratch), { recursive: true, force: true })
    }

    // The brain's path AS THE DEPLOYED CONTAINER WILL SEE IT — built from the
    // same two values that placed the file above, so the manifest cannot
    // describe a location the tarball does not have.
    //
    // `sourceDir` is dropped rather than rewritten: it records where the brain
    // was COMPILED FROM on the publisher's machine, which the dev watcher uses
    // to find source to rebuild. Inside a tarball it is meaningless at best —
    // an absolute path from someone else's disk — and for an inline cognet it
    // names a directory the bundle deliberately does not ship. Publishing a
    // path that resolves to nothing invites a consumer to trust it.
    const manifestPath = join(target, "manifest.json")
    const manifest = await fsx.readJson<Record<string, unknown>>(manifestPath)
    if (!manifest) throw err("BUNDLE_INVALID", { detail: "compiled cognet has no manifest" })
    const { sourceDir: _local, ...portable } = manifest
    const shippedPath = `${frame.name}/${BUNDLE_COGNET_DIR}/cognet.mjs`
    await Bun.write(manifestPath, JSON.stringify({ ...portable, path: shippedPath }, null, 4))
}

/** Rewrite only static imports that resolve to source-module config files we staged. */
function rebaseImports(
    source: string,
    sourceConfigPath: string,
    targetConfigPath: string,
    targets: Map<string, string>,
): string {
    const staticImport = /(\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?)(["'])([^"']+)\2/g

    return source.replace(staticImport, (statement, prefix: string, quote: string, specifier: string) => {
        if (!specifier.startsWith(".")) return statement

        const unresolved = resolve(dirname(sourceConfigPath), specifier)
        const target = targets.get(unresolved)
            ?? targets.get(`${unresolved}.ts`)
            ?? targets.get(join(unresolved, "index.ts"))
        if (!target) return statement

        let rebased = relative(dirname(targetConfigPath), target).split(sep).join("/")
        if (!rebased.startsWith(".")) rebased = `./${rebased}`
        return `${prefix}${quote}${rebased}${quote}`
    })
}

// ─── Self-host groundwork ─────────────────────────────────────────────────────

const DOCKERIGNORE = ["node_modules", ".env", ".env.*", "*.log", "source.tar.gz", ""].join("\n")

/**
 * A self-contained image for one agent.
 *
 * ── Only for callers that cannot mount ────────────────────────────────────
 *
 * The base image takes the agent's source at `/agent` and never bakes it in —
 * that is its whole design, so the ordinary way to self-host is to mount:
 *
 *     docker run -v $PWD:/agent -p 8080:8080 axon/base:<version>
 *
 * No build, no per-agent image, and an agent edit is a restart rather than a
 * rebuild. This Dockerfile exists for the cases where a mount is not available
 * — an air-gapped registry, a k8s deployment that ships one artifact — which is
 * why `axon bundle` does not emit an image unless asked.
 *
 * ── Pinned, not floating ──────────────────────────────────────────────────
 *
 * The tag is the exact base version this CLI was built against. `:latest`
 * would mean a rebuild months later silently gets a different runtime under an
 * agent that was working, which is the class of failure immutable versions
 * exist to prevent.
 *
 * It previously read `FROM axon-base:local` — an image in a PRIVATE registry
 * that no user could pull. `docker build` on it failed with "pull access
 * denied", so the self-host path it advertised had never worked.
 */
function dockerfile(): string {
    return [
        `FROM ${axonBaseRef()}`,
        "",
        "# The base image reads the agent from /agent — see @axon/docker's Hydrate.",
        "COPY . /agent",
        "",
    ].join("\n")
}
