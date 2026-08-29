/**
 * Registry source trees — download a version's tarball, parse it, build a
 * navigable file tree.
 *
 * ── Why this lives in @arcforge/cloud ────────────────────────────────────────
 *
 * It was written for the website and is now needed by the Fleet extension's
 * registry buffer, with the TUI a plausible third. Copying it would mean a
 * second tar parser — and the comments below are a record of how many ways
 * that goes wrong (GNU @LongLink, POSIX prefix, pax headers, each of which
 * shipped a visible bug before it was handled). Two copies drift; this one
 * does not.
 *
 * PURE and isomorphic by construction: bytes in, tree out. Nothing here
 * fetches, and nothing here knows what a component is — the website wraps it
 * in a Vue handle, Fleet calls it from the extension host, and neither shape
 * belongs in this file.
 *
 * That purity is also what makes a backend `files` endpoint a strictly better
 * swap later: the interface stays, only `sourceTree()` changes from parsing a
 * tarball to reading a stored manifest.
 */

import { decompress } from "fflate"
import { fileLang } from "./filetype"


export interface FileNode {
    name: string
    type: "file" | "folder"
    lang?: string
    content?: string
    /**
     * Set on a README asset instead of `content` — its bytes are served from
     * storage, never carried in the tarball this tree is parsed from. Presence of
     * this field is what tells the viewer to render media rather than open Monaco.
     */
    asset?: { path: string; bytes: number; contentType: string }
    children?: FileNode[]
}

export interface FileTreeData {
    name: string
    children: FileNode[]
}

// ── Module-level cache — survives tab switches. Keyed by kind:id:version ──────

const cache = new Map<string, { tree: FileTreeData; fetchedAt: number }>()

// ── TAR parsing ────────────────────────────────────────────────────────────────
//
// Every member here is text. README assets are published as a SEPARATE archive
// and never appear in source.tar.gz (see @arcforge/platform's bundle/assets.ts),
// which is what keeps this decoder honest — an image decoded as UTF-8 is
// kilobytes of replacement characters that the code viewer would happily render.

/**
 * The tar header's name field is 100 bytes. A longer path cannot fit, so GNU
 * tar writes a PSEUDO-ENTRY first — typeflag "L", literally named
 * "././@LongLink" — whose CONTENT is the real path, and applies it to the
 * entry that follows. POSIX tar solves the same problem differently, with a
 * "prefix" field (bytes 345–500) that is joined to the name.
 *
 * A third convention, pax (typeflag "x"), stores the path as a key/value
 * record in a preceding entry — which is why some artifacts showed a
 * "PaxHeaders" DIRECTORY containing ghost copies of the real files.
 *
 * Handling none of them meant a long path produced two wrong rows: a marker
 * file, and the real entry under a name truncated to 100 bytes. Node
 * dependency trees are full of paths that long, so any artifact shipping
 * node_modules showed a wall of them in the registry's file tree.
 */
export function parseTar(data: Uint8Array): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = []
    const decoder = new TextDecoder("utf-8", { fatal: false })
    const text = (bytes: Uint8Array) => decoder.decode(bytes).replace(/\0.*$/s, "").trim()

    let offset = 0
    /** Set by a preceding @LongLink record; consumed by the next real entry. */
    let pendingLongName: string | null = null

    while (offset + 512 <= data.length) {
        const header = data.slice(offset, offset + 512)
        const rawName = text(header.slice(0, 100))
        if (!rawName) break

        const size = parseInt(text(header.slice(124, 136)), 8) || 0
        const typeFlag = String.fromCharCode(header[156]!)
        const body = data.slice(offset + 512, offset + 512 + size)
        offset += 512 + Math.ceil(size / 512) * 512

        // GNU long name/link: the payload IS the next entry's path.
        if (typeFlag === "L" || typeFlag === "K") {
            pendingLongName = text(body)
            continue
        }

        // pax extended header: the payload is "<len> key=value\n" records,
        // of which `path` overrides the next entry's name. Both the header
        // entry and its own synthetic "PaxHeaders/..." name are metadata and
        // must never reach the tree.
        if (typeFlag === "x" || typeFlag === "g") {
            const match = decoder.decode(body).match(/^\d+ path=(.*)$/m)
            if (match) pendingLongName = match[1]!.trim()
            continue
        }

        // POSIX ustar splits a long path across prefix + name.
        const prefix = text(header.slice(345, 500))
        const path = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName)
        pendingLongName = null

        // Directories carry no content; "0"/"\0" are regular files, and other
        // flags (links, device nodes) have no source worth showing.
        if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "") continue
        if (size === 0) continue

        files.push({ path, content: decoder.decode(body) })
    }
    return files
}

// ── Tree building ──────────────────────────────────────────────────────────────

export function buildTree(files: Array<{ path: string; content: string }>, rootName: string): FileTreeData {
    const root: FileTreeData = { name: rootName, children: [] }

    // npm packs everything under a synthetic `package/` root. That is a
    // tarball convention, not the author's layout, so it is stripped before
    // the tree is built — otherwise every file in an npm-packed artifact
    // renders one level deeper than the same file in a plain-packed one.
    // Only when it wraps *everything* — a package that genuinely contains a
    // `package/` directory keeps it.
    const npmWrapped =
        files.length > 0 &&
        files.every(file => file.path.split("/").filter(Boolean)[0] === "package")
    const stripped = npmWrapped
        ? files.map(file => ({ ...file, path: file.path.split("/").filter(Boolean).slice(1).join("/") }))
        : files

    for (const file of stripped) {
        const parts = file.path.split("/").filter(part => Boolean(part) && part !== ".")
        if (parts.length === 0) continue
        // Skip .agent/, node_modules/, data/ (runtime / generated)
        const topLevel = parts[0]
        if (topLevel === ".agent" || topLevel === "node_modules" || topLevel === "data") continue

        // A tar entry ending in "/" IS a directory, not a file. Pushing it as
        // one gave `src/tools/` a file icon and `src/prompts/` none at all —
        // and any leading "./" segment rendered as a phantom "." folder.
        // Directories still get created by the walk below when their children
        // are inserted, so a bare directory entry needs nothing beyond being
        // ensured to exist.
        if (file.path.endsWith("/")) {
            let level = root.children
            for (const part of parts) {
                let folder = level.find(node => node.name === part && node.type === "folder")
                if (!folder) {
                    folder = { name: part, type: "folder", children: [] }
                    level.push(folder)
                }
                level = folder.children!
            }
            continue
        }

        let children = root.children
        for (let i = 0; i < parts.length - 1; i++) {
            let folder = children.find(n => n.name === parts[i] && n.type === "folder")
            if (!folder) {
                folder = { name: parts[i]!, type: "folder", children: [] }
                children.push(folder)
            }
            children = folder.children!
        }

        const fileName = parts[parts.length - 1]!
        children.push({
            name: fileName,
            type: "file",
            lang: fileLang(fileName),
            content: file.content,
        })
    }

    return root
}

/**
 * Find a file anywhere in the tree by name, depth-first, shallowest match
 * first. npm tarballs nest everything under `package/`, so a lookup for
 * "README.md" must not care which directory level it landed at.
 */
export function findFile(tree: FileTreeData | null, name: string): FileNode | null {
    if (!tree) return null

    const target = name.toLowerCase()
    let level: FileNode[] = tree.children

    while (level.length > 0) {
        const match = level.find(node => node.type === "file" && node.name.toLowerCase() === target)
        if (match) return match
        level = level.flatMap(node => (node.type === "folder" ? node.children ?? [] : []))
    }

    return null
}

/**
 * First file with the given extension, breadth-first — shallowest wins.
 *
 * A prompt package's payload *is* a .vue file, so its detail page renders
 * that file instead of a readme. Packages may carry several; the shallowest
 * is the entry point by convention.
 */
export function findFileByExtension(tree: FileTreeData | null, extension: string): FileNode | null {
    if (!tree) return null

    const suffix = extension.toLowerCase()
    let level: FileNode[] = tree.children

    while (level.length > 0) {
        const match = level.find(
            node => node.type === "file" && node.name.toLowerCase().endsWith(suffix),
        )
        if (match) return match
        level = level.flatMap(node => (node.type === "folder" ? node.children ?? [] : []))
    }

    return null
}

/**
 * The published tree with an `assets/` folder grafted on.
 *
 * Assets are NOT in source.tar.gz — they ship as their own archive so installing
 * an artifact never downloads docs media — so the tree parsed from the tarball has
 * no record of them. Left alone it lies by omission: a package that published four
 * screenshots showed four files and no sign of the other four.
 *
 * So the folder is synthetic, built from the version's asset manifest, and rendered
 * as an ordinary folder. That is the point: what you browse should be what shipped.
 * The nodes carry no `content` — an asset is bytes at a URL, and the viewer fetches
 * it rather than reading it out of the tree.
 *
 * PURE, and separate from `RegistrySource`. The tarball and the manifest arrive from
 * different requests at different times, and pinning them together inside the loader
 * would mean the tree could not render until both had landed. This composes them
 * whenever both exist and returns the tarball tree untouched when they do not.
 */
export function withAssets(
    tree: FileTreeData | null,
    assets: readonly { path: string; bytes: number; contentType: string }[] | null | undefined,
): FileTreeData | null {
    if (!tree) return null
    // Null means "this version predates asset recording", which is not the same as
    // having none — so no folder at all, rather than an empty one that would claim
    // the package shipped nothing.
    if (!assets || assets.length === 0) return tree

    const root: FileNode = { name: "assets", type: "folder", children: [] }

    for (const asset of [...assets].sort((a, b) => a.path.localeCompare(b.path))) {
        const parts = asset.path.split("/").filter(Boolean)
        if (parts.length === 0) continue

        let level = root.children!
        for (const part of parts.slice(0, -1)) {
            let folder = level.find(node => node.name === part && node.type === "folder")
            if (!folder) {
                folder = { name: part, type: "folder", children: [] }
                level.push(folder)
            }
            level = folder.children!
        }

        level.push({
            name: parts[parts.length - 1]!,
            type: "file",
            lang: fileLang(parts[parts.length - 1]!),
            // The asset's path under the version prefix, which is what the viewer
            // needs to build a URL. Carried instead of `content` because these
            // bytes were never in the tarball to read.
            asset: { path: asset.path, bytes: asset.bytes, contentType: asset.contentType },
        })
    }

    // Prepended, so `assets/` reads first the way a source tree lists directories
    // before files. A real `assets/` in the tarball (nothing publishes one today,
    // but a project could) wins — it is genuinely in the artifact.
    const existing = tree.children.some(node => node.name === "assets" && node.type === "folder")
    return existing ? tree : { ...tree, children: [root, ...tree.children] }
}

/**
 * Fetch, decompress and parse one version's source tarball.
 *
 * `download` is supplied rather than resolved: the signed URL comes from an
 * authenticated handle, and this module deliberately holds no client. That
 * keeps it callable from a Nuxt page, an extension host and a CLI without any
 * of them agreeing on how a request is made.
 *
 * Cached by `kind:id:version` across calls, because the same tree is asked for
 * every time a person switches back to the Source tab and a tarball is not
 * cheap. The cache is module-level and unbounded, which is right for a session
 * browsing a handful of artifacts and would not be for a crawler.
 */
export async function sourceTree(input: {
    kind: string
    id: string
    version: string
    /** Resolves a short-lived signed URL for the version's source.tar.gz. */
    download: (version: string) => Promise<string>
    /** The version's README assets, grafted on — see `withAssets`. */
    assets?: readonly { path: string; bytes: number; contentType: string }[] | null
}): Promise<FileTreeData> {
    const key = `${input.kind}:${input.id}:${input.version}`
    const hit = cache.get(key)
    if (hit) return withAssets(hit.tree, input.assets) ?? hit.tree

    const url = await input.download(input.version)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)

    const compressed = new Uint8Array(await response.arrayBuffer())
    const decompressed = await new Promise<Uint8Array>((resolve, reject) => {
        decompress(compressed, (error, result) => (error ? reject(error) : resolve(result)))
    })

    const built = buildTree(parseTar(decompressed), input.version)
    cache.set(key, { tree: built, fetchedAt: Date.now() })
    return withAssets(built, input.assets) ?? built
}
