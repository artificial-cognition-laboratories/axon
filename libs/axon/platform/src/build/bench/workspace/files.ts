import { cp, lstat, mkdir, readdir, readFile, readlink, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type {
    BenchHash,
    BenchResolvedWorkspaceDefinition,
    BenchWorkspaceChange,
    BenchWorkspaceFileState,
    BenchWorkspaceTemplate,
} from "@arcforge/types"
import { err } from "@arcforge/err"

export type WorkspaceSnapshot = Map<string, BenchWorkspaceFileState>

function hash(bytes: Uint8Array | string): BenchHash {
    return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
}

function ignored(path: string, patterns: string[]): boolean {
    return patterns.some(pattern => path === pattern || path.startsWith(`${pattern}/`) || new Bun.Glob(pattern).match(path))
}

export async function snapshotWorkspace(
    root: string,
    opts: { ignore: string[]; persistDir?: string; maxBytes?: number },
): Promise<{ files: WorkspaceSnapshot; bytes: number }> {
    const files: WorkspaceSnapshot = new Map()
    let bytes = 0

    async function walk(dir: string, prefix: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name
            if (ignored(rel, opts.ignore)) continue
            const absolute = join(dir, entry.name)
            if (entry.isSymbolicLink()) {
                const target = await readlink(absolute)
                const resolved = resolve(dirname(absolute), target)
                const boundary = resolve(root)
                if (resolved !== boundary && !resolved.startsWith(`${boundary}${sep}`)) {
                    throw err("BENCH_WORKSPACE_ESCAPE", { detail: `${rel} resolves outside the workspace source`, context: { path: rel } })
                }
                throw err("BENCH_WORKSPACE_SYMLINK_UNSUPPORTED", { context: { path: rel } })
            }
            if (entry.isDirectory()) {
                await walk(absolute, rel)
                continue
            }
            if (!entry.isFile()) continue
            const data = new Uint8Array(await readFile(absolute))
            const info = await lstat(absolute)
            const digest = hash(data)
            const state: BenchWorkspaceFileState = { hash: digest, bytes: data.byteLength, mode: info.mode & 0o777 }
            if (opts.persistDir && data.byteLength <= (opts.maxBytes ?? Number.POSITIVE_INFINITY)) {
                await mkdir(opts.persistDir, { recursive: true })
                const name = digest.slice("sha256:".length)
                await Bun.write(join(opts.persistDir, name), data)
                state.ref = `artifacts/${name}`
            }
            files.set(rel, state)
            bytes += data.byteLength
        }
    }

    if (await Bun.file(root).exists() || await lstat(root).then(() => true, () => false)) await walk(root, "")
    return { files, bytes }
}

export function snapshotHash(snapshot: WorkspaceSnapshot): BenchHash {
    const body = [...snapshot.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, state]) => `${path}\0${state.hash}\0${state.mode}`)
        .join("\n")
    return hash(body)
}

export async function prepareWorkspaceTemplate(
    benchRoot: string,
    definition: BenchResolvedWorkspaceDefinition,
): Promise<{ template: BenchWorkspaceTemplate; sourcePath?: string }> {
    if (definition.source.kind === "empty") {
        return { template: { kind: "empty", hash: hash(""), files: 0, bytes: 0 } }
    }
    const sourcePath = isAbsolute(definition.source.path)
        ? resolve(definition.source.path)
        : resolve(benchRoot, definition.source.path)
    const boundary = resolve(benchRoot)
    if (sourcePath !== boundary && !sourcePath.startsWith(`${boundary}${sep}`)) {
        throw err("BENCH_WORKSPACE_OUTSIDE_ROOT", { detail: definition.source.path, context: { path: definition.source.path } })
    }
    const info = await lstat(sourcePath).catch(() => null)
    if (!info?.isDirectory()) throw err("BENCH_WORKSPACE_SOURCE_NOT_FOUND", { detail: definition.source.path, context: { path: definition.source.path } })
    const snapshot = await snapshotWorkspace(sourcePath, { ignore: definition.capture.ignore })
    return {
        sourcePath,
        template: {
            kind: "directory",
            hash: snapshotHash(snapshot.files),
            files: snapshot.files.size,
            bytes: snapshot.bytes,
        },
    }
}

export async function materializeWorkspace(sourcePath: string | undefined, destination: string, ignore: string[] = []): Promise<void> {
    await rm(destination, { recursive: true, force: true })
    if (!sourcePath) {
        await mkdir(destination, { recursive: true })
        return
    }
    await mkdir(dirname(destination), { recursive: true })
    await cp(sourcePath, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        filter(source) {
            const rel = relative(sourcePath, source).split(sep).join("/")
            return rel === "" || !ignored(rel, ignore)
        },
    })
}

export function workspaceChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): BenchWorkspaceChange[] {
    const paths = new Set([...before.keys(), ...after.keys()])
    const changes: BenchWorkspaceChange[] = []
    for (const path of [...paths].sort()) {
        const prior = before.get(path)
        const next = after.get(path)
        if (!prior && next) changes.push({ path, kind: "added", after: next })
        else if (prior && !next) changes.push({ path, kind: "deleted", before: prior })
        else if (prior && next && (prior.hash !== next.hash || prior.mode !== next.mode)) {
            changes.push({ path, kind: "modified", before: prior, after: next })
        }
    }
    return changes
}

export async function removeWorkspace(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
}
