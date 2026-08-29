const MAX_TARBALL_BYTES = 50 * 1024 * 1024

/**
 * README assets travel as their own archive, so they get their own ceiling.
 * Mirrors the bundler's total budget (assets.ts) — the two must not disagree,
 * or one of them rejects an upload the other produced.
 */
const MAX_ASSETS_BYTES = 25 * 1024 * 1024

export type ResolvedArtifactBundle = {
    /** package.json contents — the artifact manifest. */
    config: string
    /** Version to publish — read from package.json unless overridden. */
    version: string
    tarball: Buffer
    tarballName: string
    /**
     * `assets.tar.gz`, when the bundle produced one — README media, packaged
     * separately from the source so installing an artifact never downloads it.
     * Null is the normal case: most artifacts have no assets.
     */
    assets: Buffer | null
    /** The rendered declaration string, if the bundle has one (tool-globals.d.ts). */
    manifest: string | null
    /** Kernel ABI from image.json — cognets only, null for every other kind. */
    abi: string | null
}

/**
 * Normalizes a bundle path into the publish payload, for any artifact kind.
 *
 * Keyed on package.json — which every kind has, and which also supplies the
 * version, so callers don't repeat what the manifest already says.
 *
 * Accepted:
 *   - a bundle directory containing package.json + source.tar.gz
 *   - a path directly to a .tar.gz, with package.json sitting beside it
 *
 * `requireImage` makes image.json mandatory. An agent bundle is only
 * deployable with its build manifest, so the deploy path asks for it here —
 * failing at the call site with the fix ("run `axon build` first") rather
 * than server-side with a 400 on an upload that already crossed the wire.
 * Every other kind treats image.json as optional, present only to carry
 * `abi` for cognets.
 */
export async function Bundle(path: string, opts?: { version?: string; requireImage?: boolean }): Promise<ResolvedArtifactBundle> {
    const { readFile } = await import("node:fs/promises")
    const { existsSync, statSync } = await import("node:fs")
    const { basename, join } = await import("node:path")

    if (!existsSync(path)) {
        throw new Error(`bundle path does not exist: ${path}`)
    }

    const isDir = statSync(path).isDirectory()
    const dir = isDir ? path : join(path, "..")
    const tarballPath = isDir ? join(path, "source.tar.gz") : path

    if (!isDir && !tarballPath.endsWith(".tar.gz")) {
        throw new Error(`expected a bundle directory or a .tar.gz file, got: ${path}`)
    }
    if (!existsSync(tarballPath)) {
        throw new Error(`bundle has no source.tar.gz at ${tarballPath} — run \`axon build\` first`)
    }

    // package.json sits beside the tarball for modules and cognets (their
    // bundlers copy it in), but at the PROJECT ROOT for agents — the frame
    // holds generated declarations and the deploy image, never a manifest.
    //
    // The walk is two levels, not one, because a bundle now lands in the
    // frame's `build/` area (`<root>/.agent/build/`) rather than the frame
    // root. One level reaches `.agent/` and stops, which is what made
    // publishing an agent fail with "no package.json at .agent/build/…".
    // Searching upward by a bounded number of steps keeps this file out of the
    // business of knowing the frame's interior — that layout belongs to
    // @arcforge/platform, and encoding "build/" here would be a second copy of
    // it that can drift.
    const configPath = [
        join(dir, "package.json"),
        join(dir, "..", "package.json"),
        join(dir, "..", "..", "package.json"),
    ].find(candidate => existsSync(candidate))

    if (!configPath) {
        throw new Error(`bundle has no package.json at ${join(dir, "package.json")} or above it`)
    }

    const config = await readFile(configPath, "utf-8")

    const version = opts?.version ?? (JSON.parse(config) as { version?: unknown }).version
    if (typeof version !== "string" || version.length === 0) {
        throw new Error(`bundle has no version — set "version" in package.json or pass one explicitly`)
    }

    const tarball = await readFile(tarballPath)
    if (tarball.byteLength > MAX_TARBALL_BYTES) {
        throw new Error(`tarball is ${Math.round(tarball.byteLength / 1024 / 1024)}MB — the registry limit is 50MB`)
    }

    // The published tool surface. Beside the tarball for a module whose
    // bundler copied it in, otherwise in the frame's sibling `types/` area
    // where typegen writes it — the same two-shapes situation as package.json
    // above, and absent is a legitimate answer (a project with no tools
    // publishes no declarations), so this never throws.
    const manifestPath = [
        join(dir, "tool-globals.d.ts"),
        join(dir, "..", "types", "tool-globals.d.ts"),
    ].find(candidate => existsSync(candidate))
    const manifest = manifestPath ? await readFile(manifestPath, "utf-8") : null

    // The kernel ABI, for a cognet. The bundler lifted it out of
    // cognet.config.ts into image.json precisely so it can travel with the
    // publish — it is a resolution constraint the registry has to index, not
    // payload the server can dig out of the tarball later.
    const imagePath = join(dir, "image.json")
    if (opts?.requireImage && !existsSync(imagePath)) {
        throw new Error(`bundle has no image.json at ${imagePath} — run \`axon build\` first`)
    }
    const abi = existsSync(imagePath)
        ? (JSON.parse(await readFile(imagePath, "utf-8")) as { abi?: unknown }).abi
        : undefined

    // README assets, beside the source tarball in the bundle directory. Absent
    // is the normal case and never an error — most artifacts illustrate nothing.
    const assetsPath = join(dir, "assets.tar.gz")
    const assets = existsSync(assetsPath) ? await readFile(assetsPath) : null
    if (assets && assets.byteLength > MAX_ASSETS_BYTES) {
        throw new Error(
            `assets are ${Math.round(assets.byteLength / 1024 / 1024)}MB — the limit is ${MAX_ASSETS_BYTES / 1024 / 1024}MB`,
        )
    }

    return {
        config,
        version,
        tarball,
        tarballName: basename(tarballPath),
        assets,
        manifest,
        abi: typeof abi === "string" ? abi : null,
    }
}
