import { join } from "node:path"
import { Scripts } from "../../blueprint/scan/scripts"
import { Tools } from "../../blueprint/scan/tools"
import { fsx } from "../../../utils/fs"
import { Frame, FRAME } from "../../frame"
import { Assets } from "./assets"
import type { ArtifactsT } from "./artifacts"
import type { StageT } from "./stage"
import type { BundleResult, ModuleImage } from "./types"

type ModuleOpts = {
    root: string
    artifacts: ArtifactsT
    stage: StageT
}

/**
 * Module bundle — .module/build/image.json + manifest.json + source.tar.gz,
 * the registry publish.
 *
 * Modules ship as source with one addition no other kind has: a surface
 * manifest of their tools and scripts, scanned with the same scanners the
 * blueprint uses. It rides along because it is the module's public surface —
 * shipping it means the registry can render "what this gives your agent"
 * straight from the artifact rather than from metadata recorded beside it.
 */
export function Module(opts: ModuleOpts) {
    const { root, artifacts, stage } = opts
    const frame = Frame({ root: root, kind: "module" })

    return {
        async build(): Promise<BundleResult> {
            const pkg = await artifacts.identity()
            const bundleDir = await artifacts.open(frame.path("build"), [
                "image.json",
                "package.json",
                "manifest.json",
                "source.tar.gz",
                // Assets from a previous publish, archive and staging tree
                // alike. Cleared by name like every other output: a deleted
                // asset must not survive into the next publish, and nothing
                // else signals that it should be gone.
                "assets.tar.gz",
                ".assets",
            ])

            const image: ModuleImage = {
                kind: "module",
                moduleId: pkg.name,
                version: pkg.version,
                public: pkg.public,
                builtAt: new Date().toISOString(),
                ...(pkg.description ? { description: pkg.description } : {}),
            }
            await artifacts.image(bundleDir, image)
            // package.json rides along — modules.publish() reads it.
            await artifacts.package(bundleDir, pkg.raw)

            const [tools, scripts] = await Promise.all([Tools(root), Scripts(root)])
            await artifacts.json(bundleDir, "manifest.json", {
                name: pkg.name,
                version: pkg.version,
                kind: "module" as const,
                tools: tools.entries,
                scripts: scripts.entries,
                prompts: [],
            })

            // Tar entries, relative to the project root — so they name the
            // frame's areas the same way the writers that produced them do.
            const manifestEntry = `${frame.name}/${FRAME.build}/manifest.json`
            const globalsEntry = `${frame.name}/${FRAME.types}/tool-globals.d.ts`

            const entries = ["module.config.ts", "package.json", manifestEntry]
            if (fsx.exists(join(root, "src"))) entries.unshift("src")
            // `server/` is where a module DOES things. Its plugins are loaded
            // by the runtime at boot (the scanner sets `serverPath` from this
            // directory), so a module whose whole purpose is a plugin shipped
            // as an inert package without it — installed, declared, scanned,
            // and silently doing nothing.
            //
            // Every sensory module was in exactly that state: screenshare,
            // camera, microphone, mouse and compute all have a `server/` and
            // none of them reached a consumer. The agent bundler has always
            // included "server" for the same reason; this is the same concept,
            // one omission.
            if (fsx.exists(join(root, "server"))) entries.unshift("server")
            // `data/knowledge/` is where a module KNOWS things — reference
            // material the consuming agent's brain can read, discovered by the
            // build and namespaced under this module's name.
            //
            // Same omission this file already fixed once for `server/`: the
            // module installs, the scanner runs, and the surface is silently
            // empty. @axon/docs shipped 194 markdown files as a package
            // containing none of them, which reads to its author as knowledge
            // that mysteriously does not exist rather than as a bundle that
            // never carried it.
            //
            // Only `data/knowledge/`, never `data/` — the other rooms under it
            // (workspace/, modules/) are an AGENT's runtime scratch, and a
            // module has no business shipping either.
            if (fsx.exists(join(root, "data", "knowledge"))) entries.unshift(join("data", "knowledge"))
            if (fsx.exists(join(root, "README.md"))) entries.push("README.md")
            // The module's tool declarations ride along: they are its public
            // surface, same reason the manifest does.
            if (fsx.exists(join(root, globalsEntry))) {
                entries.push(globalsEntry)
            }

            // README assets — their own tarball, never a member of this one.
            // Every publishable kind has a registry page, so every publishable
            // kind carries assets; this was wired into the source bundler first
            // and an agent's mp4 silently never reached storage, which reads to
            // its author as a broken player rather than a missing upload.
            const assets = await Assets({ root, stage }).collect(bundleDir)

            const tarball = join(bundleDir, "source.tar.gz")
            await stage.npm(bundleDir, tarball, entries)

            return {
                image,
                tarball,
                assets: assets.assets,
                ...(assets.tarball ? { assetsTarball: assets.tarball } : {}),
            }
        },
    }
}

export type ModuleBundleT = ReturnType<typeof Module>
