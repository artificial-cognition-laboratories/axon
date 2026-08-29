import { join } from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { err } from "@arcforge/err"
import type { ManifestT } from "../manifest"

type ArtifactsOpts = {
    root: string
    manifest: ManifestT
}

/**
 * Artifacts — the files a bundle writes into the project's `build/` area.
 *
 * The bundle used to write into the frame ROOT, alongside the prepared
 * authoring frame (globals.d.ts, tsconfig.json), which forced a rule on it:
 * clear only its OWN artifacts by name, never the directory, or an otherwise
 * successful publish would delete the editor's types. Now that generated
 * types live in `types/` and bundles in `build/`, the two cannot collide —
 * the clear list survives as a narrower guarantee (a failed publish leaves no
 * stale tarball) rather than as the thing standing between publish and a
 * broken editor.
 *
 * Identity comes from Manifest — this does NOT read package.json itself. That
 * distinction is the boundary: Manifest owns the project's declaration files;
 * this owns the derived artifacts written beside them.
 */
export function Artifacts(opts: ArtifactsOpts) {
    const { root, manifest } = opts

    return {
        /**
         * The project's publishable identity. Throws when package.json is
         * absent or unnamed — neither is publishable.
         */
        async identity() {
            const pkg = await manifest.package.read().catch(() => null)
            if (!pkg) {
                throw err("BUNDLE_INVALID", { detail: `no package.json at ${root}`, context: { root } })
            }
            if (!pkg.name) {
                throw err("BUNDLE_INVALID", { detail: `package.json at ${root} has no name`, context: { root } })
            }

            return {
                name: pkg.name,
                version: pkg.version ?? "0.0.0",
                description: pkg.description,
                // npm convention: "private": true means private; absent/false means public.
                public: pkg.private !== true,
                raw: pkg,
            }
        },

        /**
         * Prepare the bundle directory, clearing only this bundle's own
         * outputs. Takes an ABSOLUTE path — callers resolve it through
         * `Frame().path("build")` rather than passing a fragment this has to
         * join, so there is one authority on where a bundle lands.
         *
         * `recursive` so an entry naming a DIRECTORY clears too — the source
         * bundler's `.assets` staging area is one, and a non-recursive rm
         * throws EISDIR on it rather than removing it. Still by name, so the
         * guarantee is unchanged: nothing outside the clear list is touched.
         */
        async open(bundleDir: string, clear: string[] = []): Promise<string> {
            await mkdir(bundleDir, { recursive: true })
            await Promise.all(clear.map(file => rm(join(bundleDir, file), { force: true, recursive: true })))
            return bundleDir
        },

        /** Write image.json — the artifact record every kind ships. */
        async image(bundleDir: string, image: unknown): Promise<void> {
            await Bun.write(join(bundleDir, "image.json"), JSON.stringify(image, null, 2) + "\n")
        },

        /** Write the package.json copy the registry reads name/version/visibility from. */
        async package(bundleDir: string, raw: unknown): Promise<void> {
            await Bun.write(join(bundleDir, "package.json"), JSON.stringify(raw, null, 2) + "\n")
        },

        /** Write an arbitrary named JSON artifact into the bundle dir (module manifests). */
        async json(bundleDir: string, name: string, value: unknown): Promise<void> {
            await Bun.write(join(bundleDir, name), JSON.stringify(value, null, 2) + "\n")
        },
    }
}

export type ArtifactsT = ReturnType<typeof Artifacts>
