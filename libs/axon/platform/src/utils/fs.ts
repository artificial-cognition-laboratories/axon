import { readdir, stat } from "node:fs/promises"
import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"

/**
 * Shared filesystem discovery tools — every blueprint scan leaf walks
 * directories through here instead of hand-rolling readdir recursion.
 * A missing directory is a real state (empty surface), so listing one
 * returns [] — anything else throws.
 */
export const fsx = {
    exists(path: string): boolean {
        return existsSync(path)
    },

    /**
     * The target of a symlink, or null when the path is not one.
     *
     * Distinct from exists(), which FOLLOWS links and therefore answers false
     * for a dangling one — losing the very fact a caller needs to explain why.
     * A dependency tree grafted onto a shared cache is entirely symlinks, so
     * "the link is there but its target is gone" is a real and common state
     * that reads as "not installed" without this.
     */
    readLink(path: string): string | null {
        try {
            return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
        } catch {
            return null
        }
    },

    /**
     * Exists AND is a regular file. Distinct from exists() because a path can
     * name a directory: a resolver looking for `./brain/cognet.config.ts` that
     * accepts `./brain` hands its caller a directory where a file was promised.
     *
     * Never throws — a predicate that answers "is this a file" with an
     * exception is unusable in the candidate loops that call it. Note
     * `throwIfNoEntry: false` covers only ENOENT: a path whose PARENT is a
     * regular file (`foo.ts/bar.ts`, which a resolver generates naturally
     * while trying candidates) raises ENOTDIR, which is still just "no".
     */
    isFile(path: string): boolean {
        try {
            return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
        } catch {
            return false
        }
    },

    /** Immediate children (names) of a directory. Missing dir = []. */
    async list(dir: string): Promise<string[]> {
        try {
            return await readdir(dir)
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
            throw error
        }
    },

    /**
     * Recursive file walk. Returns absolute + relative paths, sorted for
     * determinism. `skipDirs` prunes subtrees by directory name.
     */
    async walk(dir: string, opts?: { skipDirs?: string[] }): Promise<Array<{ absPath: string; relPath: string }>> {
        const results: Array<{ absPath: string; relPath: string }> = []

        async function descend(current: string, prefix: string): Promise<void> {
            for (const entry of await fsx.list(current)) {
                const absPath = join(current, entry)
                const relPath = prefix ? `${prefix}/${entry}` : entry
                const info = await stat(absPath).catch(() => null)
                if (!info) continue
                if (info.isDirectory()) {
                    if (opts?.skipDirs?.includes(entry)) continue
                    await descend(absPath, relPath)
                } else {
                    results.push({ absPath, relPath })
                }
            }
        }

        await descend(dir, "")
        return results.sort((a, b) => a.relPath.localeCompare(b.relPath))
    },

    /**
     * Parse a JSON file, or null when it doesn't exist.
     *
     * Corrupt JSON throws CORRUPT_JSON; an unreadable file throws
     * FILE_UNREADABLE. Only absence is a null.
     */
    async readJson<T = Record<string, unknown>>(path: string): Promise<T | null> {
        const text = await readFile(path)
        if (text === null) return null

        try {
            return JSON.parse(text) as T
        } catch (cause) {
            throw err("CORRUPT_JSON", {
                detail: `corrupt JSON at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
                context: { path: path },
                cause: cause,
            })
        }
    },

    /**
     * Read a text file, or null when it doesn't exist.
     *
     * Null means ABSENT and nothing else. A file that exists but cannot be read
     * throws — see readFile below for why that distinction matters.
     */
    readText(path: string): Promise<string | null> {
        return readFile(path)
    },
}

/**
 * Read a file, distinguishing "not there" from "there but unreadable".
 *
 * Absence is an ordinary state across this package: a project with no README,
 * an agent with no .env, a module with no package.json. Callers read null as
 * "that surface doesn't exist" and carry on, which is correct.
 *
 * Everything else is not. This used to swallow every error and return null, so
 * an axon.config.ts with wrong permissions — or read mid-write, or shadowed by
 * a directory — reported as a MISSING config. The user was then told to create
 * a file that was already there, which is the wrong fix for the problem they
 * actually had. Absence is data; unreadable is a fault, and faults belong at
 * the boundary that detects them.
 */
async function readFile(path: string): Promise<string | null> {
    try {
        return await Bun.file(path).text()
    } catch (cause) {
        const code = (cause as { code?: string })?.code
        if (code === "ENOENT") return null

        throw err("FILE_UNREADABLE", {
            detail: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            context: { path: path, ...(code ? { code: code } : {}) },
            cause: cause,
        })
    }
}
