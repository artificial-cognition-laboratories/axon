import { dirname, join, relative, sep } from "node:path"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import type { StageT } from "./stage"

/**
 * Assets — an author's `assets/` folder, validated and compressed into
 * publishable bytes.
 *
 * README screenshots used to live wherever the author could get a URL — in
 * practice a Discord CDN link, which is an attachment URL carrying an expiry
 * signature in its query string. A README is permanent and that link is not,
 * so every published package was accumulating images that would eventually
 * render as broken boxes on a page we serve.
 *
 * So assets become part of the artifact: unpacked to
 * `<kind>s/<id>/versions/<v>/assets/` on publish and addressed relatively
 * (`./assets/x.png`), so one README renders correctly in the repo, on GitHub,
 * and on the site.
 *
 * ── They are a SEPARATE artifact from source.tar.gz, deliberately ───────────
 *
 * This produces its own `assets.tar.gz`, uploaded as its own multipart part.
 * The first version of this shipped assets INSIDE source.tar.gz on the grounds
 * that an asset is a source file the author committed — which is true about
 * provenance and irrelevant to distribution. Measured on @axon/ember-theme:
 * 60,272 of 60,844 bytes (99%) of the install payload was docs screenshots for
 * 5KB of actual code, downloaded by every `axon install` and every transitive
 * dependency resolution, and read by nobody — the site serves the unpacked
 * per-version objects, never the tarball copy.
 *
 * A 10MB demo video for a 100KB extension is the case that makes it obvious.
 * Docs media must not be on the install path, so the two payloads stay apart
 * all the way from the bundler to storage.
 *
 * ── Why this is a leaf and not a row in the kind table ──────────────────────
 *
 * KINDS.files exists for per-kind tarball entries, and assets are NOT per-kind
 * — every source-published kind gets them on the same terms. More importantly
 * an asset is not just an entry to copy: it is validated, re-encoded, budgeted
 * and packaged, which is real work that belongs to something that owns it. The
 * kind table stays a table of differences.
 *
 * ── The staging directory ──────────────────────────────────────────────────
 *
 * Processed bytes cannot be written back over the author's files — that is
 * destroying source in order to publish it. So `collect()` writes compressed
 * assets into the bundle directory under `.assets/assets/…` and tars THAT,
 * giving an archive whose members are `assets/<path>`. The author's `assets/`
 * is never modified.
 */

/**
 * Per-asset ceiling.
 *
 * Generous because assets are OFF the install path: they ship as their own
 * tarball, are unpacked to per-version objects, and are fetched only by someone
 * actually looking at the page. A 10MB demo video costs that one viewer, not
 * every `axon install` — which is the whole reason this is not in source.tar.gz.
 */
const MAX_ASSET_BYTES = 10 * 1024 * 1024

/**
 * Ceiling for the folder as a whole.
 *
 * Still bounded: every published version stores its own copy forever, and the
 * publish request has to carry the bytes in one piece.
 */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024

/**
 * Raster formats we recompress. Each is re-encoded in its OWN format — see
 * `compress` for why the filename must never change.
 *
 * GIF is included but handled as animated: re-encoding an animated GIF to a
 * still frame would silently destroy the thing it was uploaded to show.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"])

/**
 * Video is passed through untouched — validated, never transcoded.
 *
 * Transcoding needs ffmpeg, which is not a dependency `axon publish` can
 * assume on a user's machine; compressing when present and skipping when
 * absent would mean the same input publishes different bytes depending on who
 * ran it. A size limit is the honest guardrail.
 */
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"])

/**
 * SVG is deliberately absent from both sets.
 *
 * An SVG is an executable document — it can carry `<script>` and event
 * handlers — and these bytes are served from our own storage origin, so a
 * published SVG is a stored-XSS vector against every visitor reading that
 * README. Accepting it would mean owning an SVG sanitizer as a security
 * boundary, which is a large commitment for a screenshot format.
 */
const REFUSED_EXTENSIONS = new Set(["svg", "svgz"])

/** Longest edge we keep. A README column is ~700px; 1600 covers retina. */
const MAX_IMAGE_WIDTH = 1600

/** Lossy encoders only — PNG and GIF stay lossless (see `encodeAs`). */
const WEBP_QUALITY = 80
const JPEG_QUALITY = 82

/** What one asset became, for the CLI's publish report. */
export type AssetReport = {
    /** Path relative to the project root, as the README would reference it. */
    path: string
    /** Bytes on the author's disk. */
    original: number
    /** Bytes as published. Equal to `original` when passed through. */
    final: number
    /** True when we re-encoded it. */
    compressed: boolean
}

export type AssetsResult = {
    /**
     * Absolute path to `assets.tar.gz`, or null when the project has no assets.
     *
     * Its members are `assets/<path>` — no npm `package/` prefix, because this
     * archive is never installed by a package manager. It is uploaded as its own
     * publish part, unpacked server-side into per-version objects, and then
     * discarded: keeping it would store every asset twice forever for no reader.
     */
    tarball: string | null
    /** Every asset published, in tarball order. */
    assets: AssetReport[]
    /** Total published bytes. */
    total: number
}

type AssetsOpts = {
    root: string
    /** Packaging is Stage's job — this leaf owns validation and compression. */
    stage: Pick<StageT, "tar">
}

export function Assets(opts: AssetsOpts) {
    const root = opts.root

    return {
        /**
         * Validate and compress `assets/` into `<bundleDir>/assets.tar.gz`.
         *
         * Returns `{ tarball: null }` when the project has no assets folder —
         * an absent folder is an ordinary state, not a failure. An INVALID asset
         * is a failure and throws: a refused type or an over-budget file is
         * something the author must see before it becomes an immutable
         * published version.
         */
        async collect(bundleDir: string): Promise<AssetsResult> {
            const sourceDir = join(root, "assets")
            if (!fsx.exists(sourceDir)) return { tarball: null, assets: [], total: 0 }

            const found = await fsx.walk(sourceDir)
            if (found.length === 0) return { tarball: null, assets: [], total: 0 }

            // `<bundleDir>/.assets/assets/…` — the trailing `assets` is the
            // directory name as it must appear INSIDE the archive, so taring
            // `.assets` with the entry `assets` yields members named
            // `assets/<path>`. That is what the server unpacks by prefix.
            const stageDir = join(bundleDir, ".assets")
            const targetDir = join(stageDir, "assets")
            const reports: AssetReport[] = []
            let total = 0

            for (const file of found) {
                // A symlink is refused rather than followed. Following one
                // publishes bytes from outside the project (`assets/x.png` ->
                // `~/.ssh/id_rsa` is a valid symlink), and the archive would
                // carry a link the server then has to decide how to extract.
                const info = await lstat(file.absPath)
                if (info.isSymbolicLink()) {
                    throw err("ASSET_PATH_INVALID", {
                        detail: `assets/${file.relPath} is a symlink`,
                        context: { path: file.relPath },
                    })
                }

                // `walk` builds relPath by joining names, so this cannot
                // currently escape — asserted anyway because the guarantee that
                // matters is about the path we WRITE, and that must not depend
                // on a helper two modules away keeping its current behaviour.
                const destination = join(targetDir, file.relPath)
                if (!isInside(targetDir, destination)) {
                    throw err("ASSET_PATH_INVALID", {
                        detail: `assets/${file.relPath} escapes the assets directory`,
                        context: { path: file.relPath },
                    })
                }

                const extension = extensionOf(file.relPath)
                if (REFUSED_EXTENSIONS.has(extension)) {
                    throw err("ASSET_TYPE_REFUSED", {
                        detail: `assets/${file.relPath} is an SVG — SVG can carry scripts and is not served from the registry`,
                        context: { path: file.relPath, extension },
                    })
                }

                const isImage = IMAGE_EXTENSIONS.has(extension)
                const isVideo = VIDEO_EXTENSIONS.has(extension)
                if (!isImage && !isVideo) {
                    throw err("ASSET_TYPE_REFUSED", {
                        detail:
                            `assets/${file.relPath} has unsupported extension ".${extension}" — `
                            + `accepted: ${[...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(", ")}`,
                        context: { path: file.relPath, extension },
                    })
                }

                const original = await readFile(file.absPath)

                // Checked BEFORE compression as well as after: a 400MB PNG
                // must be refused rather than handed to an image decoder that
                // will try to hold it, and its decompressed pixel buffer is
                // far larger than the file on disk.
                if (original.byteLength > MAX_ASSET_BYTES) {
                    throw err("ASSET_TOO_LARGE", {
                        detail: `assets/${file.relPath} is ${mb(original.byteLength)} (max ${mb(MAX_ASSET_BYTES)} per asset)`,
                        context: { path: file.relPath, bytes: original.byteLength, limit: MAX_ASSET_BYTES },
                    })
                }

                const output = isImage
                    ? await compress(original, file.relPath, extension)
                    : { data: original, path: file.relPath, compressed: false }

                const finalDestination = join(targetDir, output.path)
                await mkdir(dirname(finalDestination), { recursive: true })
                await writeFile(finalDestination, output.data)

                total += output.data.byteLength
                reports.push({
                    path: `assets/${output.path}`,
                    original: original.byteLength,
                    final: output.data.byteLength,
                    compressed: output.compressed,
                })
            }

            if (total > MAX_TOTAL_BYTES) {
                throw err("ASSETS_BUDGET_EXCEEDED", {
                    detail: `assets/ totals ${mb(total)} after compression (max ${mb(MAX_TOTAL_BYTES)} per version)`,
                    context: { bytes: total, limit: MAX_TOTAL_BYTES },
                })
            }

            // Tar `assets` FROM the staging dir, so every member is named
            // `assets/<path>` — no npm `package/` prefix, because nothing
            // installs this archive.
            const tarball = join(bundleDir, "assets.tar.gz")
            try {
                await opts.stage.tar(stageDir, tarball, ["assets"])
            } finally {
                // The staged copies exist only to be packaged. Left behind they
                // would be a second copy of every asset in the project tree,
                // and a stale one after the next edit.
                await rm(stageDir, { recursive: true, force: true })
            }

            return { tarball, assets: reports, total }
        },
    }
}

export type AssetsT = ReturnType<typeof Assets>

/**
 * Compress a raster image IN ITS OWN FORMAT, or return it untouched when that
 * would make it larger.
 *
 * ── The filename never changes, and that is a hard requirement ──────────────
 *
 * An earlier version converted everything to WebP and renamed the file. That
 * silently broke every README it touched: the author writes
 * `./assets/ember.png`, the site resolves exactly that path, and the object in
 * storage was `ember.webp` — a 404 on every compressed image, discovered only
 * by rendering the page. A rename would force the SITE to guess what the
 * BUNDLER did to a filename, which is a coupling with no upside.
 *
 * Keeping the format also keeps content-type honest. The backend derives the
 * type from the extension, so `.png` holding WebP bytes would be served as
 * `image/png` — a lie that browsers tolerate unevenly.
 *
 * And on real content it is simply better: a terminal screenshot is flat colour
 * with sharp edges, exactly what PNG's palette encoder is for. Measured on
 * ember-theme, format-preserving PNG beat WebP 13KB to 29KB from a 34KB source.
 * Lossy WebP only wins on photographs, which a README rarely contains.
 *
 * ── Why sharp is imported here and not at the top of the file ──────────────
 *
 * sharp is a NATIVE module, and this file is reachable from
 * `@arcforge/platform/build/project` — the same barrel the Fleet VS Code
 * extension imports `Frame` from. A top-level import would load a native
 * binary into the extension host on any Fleet startup, for a code path
 * publishing never runs there. Importing inside the one function that needs it
 * keeps the cost on `axon publish` alone.
 */
async function compress(
    data: Buffer,
    path: string,
    extension: string,
): Promise<{ data: Buffer; path: string; compressed: boolean }> {
    const sharp = (await import("sharp")).default

    // An animated GIF re-encoded without `animated: true` collapses to its
    // first frame — a terminal demo silently becoming a screenshot.
    const animated = extension === "gif"

    let encoded: Buffer
    try {
        const pipeline = sharp(data, { animated })
            .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })

        encoded = await encodeAs(pipeline, extension).toBuffer()
    } catch (cause) {
        // A file named .png that sharp cannot decode is corrupt or mislabelled.
        // Publishing it would ship a broken image, so this throws rather than
        // falling back to the original bytes.
        throw err("ASSET_UNREADABLE", {
            detail: `assets/${path} could not be decoded as an image`,
            context: { path },
            cause,
        })
    }

    // Already-optimized art can come out bigger — keeping the original is both
    // smaller and fewer transformations to explain.
    if (encoded.byteLength >= data.byteLength) {
        return { data, path, compressed: false }
    }

    return { data: encoded, path, compressed: true }
}

/**
 * Apply the encoder for the image's OWN format.
 *
 * `palette: true` on PNG is what does the real work on screenshots: it quantizes
 * to an indexed palette, which is how a flat-colour terminal capture goes from
 * 34KB to 13KB. Lossless for images that already have few colours, which a
 * terminal screenshot does by construction.
 */
function encodeAs(pipeline: import("sharp").Sharp, extension: string): import("sharp").Sharp {
    switch (extension) {
        case "png":
            return pipeline.png({ compressionLevel: 9, palette: true })
        case "jpg":
        case "jpeg":
            return pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        case "webp":
            return pipeline.webp({ quality: WEBP_QUALITY })
        case "gif":
            return pipeline.gif()
        default:
            // Unreachable: callers gate on IMAGE_EXTENSIONS. Throwing rather
            // than passing bytes through keeps "which formats are compressed"
            // answerable in one place instead of two that can disagree.
            throw err("ASSET_TYPE_REFUSED", {
                detail: `no encoder for image extension ".${extension}"`,
                context: { extension },
            })
    }
}

function extensionOf(path: string): string {
    return path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""
}

/** Is `target` inside `parent` — the path-traversal assertion. */
function isInside(parent: string, target: string): boolean {
    const rel = relative(parent, target)
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep)
}

function mb(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
