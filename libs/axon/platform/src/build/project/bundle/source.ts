import { join } from "node:path"
import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { readCognetAbi } from "../../blueprint"
import { fsx } from "../../../utils/fs"
import { KINDS } from "../kinds"
import { Frame } from "../../frame"
import { Assets, type AssetReport } from "./assets"
import type { ArtifactsT } from "./artifacts"
import type { StageT } from "./stage"
import type { BundleResult, SourceImage } from "./types"

type SourceOpts = {
    root: string
    artifacts: ArtifactsT
    stage: StageT
}

/**
 * Source bundle — cognets, benches and prompts, packaged for the registry.
 *
 * All three are published as SOURCE. A cognet is compiled by the CONSUMER
 * against the core runtime it will actually run against (a prebuilt bundle
 * would carry a frozen copy of core's internals into an agent whose kernel has
 * moved), and a bench is a definition others run against their own agents.
 * Neither has a build step here; the artifact is the authoring tree.
 *
 * The npm `package/` prefix Stage() applies is what makes them installable by
 * `bun add` — and that is exactly how an agent acquires its cognet:
 * `cognet: "@axon/zero"` becomes a package.json dependency resolved through
 * the registry's npm surface, no bespoke install path.
 *
 * Per-kind differences are read from the kind table, never branched on here.
 */
export function Source(opts: SourceOpts) {
    const { root, artifacts, stage } = opts

    return {
        async build(kind: SourceImage["kind"]): Promise<BundleResult> {
            const spec = KINDS[kind]

            if (!fsx.exists(join(root, spec.config))) {
                throw err("BUNDLE_INVALID", {
                    detail: `no ${spec.config} at ${root}`,
                    context: { root, kind },
                })
            }

            const pkg = await artifacts.identity()
            const bundleDir = await artifacts.open(Frame({ root: root, kind: kind }).path("build"), [
                "image.json",
                "package.json",
                "source.tar.gz",
                // Assets from a previous publish, both the archive and the
                // staging tree. Cleared by name like every other output: a
                // deleted asset must not survive into the next publish, and
                // there is no other signal that it should be gone.
                "assets.tar.gz",
                ".assets",
            ])

            // A cognet's ABI is the kernel contract it targets, and it is the
            // only thing that says which kernels can load it. Lifted out of
            // cognet.config.ts HERE so the registry can record it: otherwise
            // the value stays sealed in the tarball and the resolve path can
            // only offer "latest" and hope.
            //
            // Unpinned falls back to THIS CLI's kernel rather than throwing.
            // Publish compiles the candidate from source with this CLI to
            // prove a consumer could, so an unpinned cognet genuinely was
            // validated against this ABI — recording it is a fact, and the
            // row must carry one either way or the resolver cannot place it.
            const abi = kind === "cognet"
                ? (await readCognetAbi(root)) ?? KERNEL_ABI_VERSION
                : undefined

            const image: SourceImage = {
                kind,
                name: pkg.name,
                version: pkg.version,
                public: pkg.public,
                builtAt: new Date().toISOString(),
                ...(pkg.description ? { description: pkg.description } : {}),
                ...(abi !== undefined ? { abi } : {}),
            }
            await artifacts.image(bundleDir, image)
            // package.json rides along — publish reads name/version/visibility from it.
            await artifacts.package(bundleDir, pkg.raw)

            const entries = [spec.config, "package.json"]
            if (fsx.exists(join(root, "src"))) entries.unshift("src")
            if (fsx.exists(join(root, "plugins"))) entries.push("plugins")
            if (fsx.exists(join(root, "README.md"))) entries.push("README.md")

            // Root-level modules the source imports. `src/main.ts` doing
            // `import { brain } from "../config"` is ordinary TypeScript, and
            // a whitelist of src/plugins/config silently dropped that file
            // from the tarball — the consumer then failed to compile with an
            // unresolvable import naming a path that exists in the author's
            // repo and nowhere else. Publishing must ship what the source
            // actually references, not what a fixed layout predicts.
            for (const name of await fsx.list(root)) {
                if (entries.includes(name)) continue
                if (!/\.(ts|tsx|js|mjs|json)$/.test(name)) continue
                if (name.startsWith(".") || name.endsWith(".test.ts")) continue
                if (name === "tsconfig.json" || name === "bun.lock") continue
                if (!fsx.isFile(join(root, name))) continue
                entries.push(name)
            }

            // Whatever else this kind declares as its own (prompt packs ship
            // their top-level units) — data from the kind table, not a branch.
            if (spec.files) {
                entries.push(...(await spec.files(root)).filter(entry => !entries.includes(entry)))
            }

            // README assets — their OWN tarball, never a member of source.tar.gz.
            // Docs media on the install path means every consumer downloads it:
            // measured at 99% of @axon/ember-theme's payload for bytes only the
            // website ever reads. `entries` deliberately never contains "assets".
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

export type SourceBundleT = ReturnType<typeof Source>
