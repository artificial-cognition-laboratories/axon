import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readSettingsSync } from "@arcforge/platform/build/extensions/edit"
import { err } from "@arcforge/err"
import type { DefinitionFile, InstalledAgent } from "./types"

type ProjectsOpts = {
    /** The stores whose profiles hold agent projects. Defaults to both distributions under the home directory. */
    stores?: readonly string[]
}

/**
 * Projects — the agent projects on disk under a set of stores.
 *
 * Read from disk on every call. A project appears when someone runs
 * `axon init` in another terminal, and there is no event for that — a cached
 * answer would be stale exactly when a new user is looking for the agent they
 * just made. It is one directory listing.
 *
 * Absent is an answer; unreadable is a fault. A machine with no profile has
 * no agents, but a store that could not be read must never look like one with
 * none — a remote inventory would report an empty machine that is not.
 */
export function Projects(opts: ProjectsOpts = {}) {
    const stores = opts.stores ?? storeRoots()

    return {
        /** Every project, most recently used first. */
        list(): InstalledAgent[] {
            return scan(stores)
        },
    }
}

export type ProjectsT = ReturnType<typeof Projects>

/**
 * Every agent project under the given stores, most recently used first: each
 * profile's own `agents/`, and every folder it watches (`axon watch`, the
 * `paths` its profile.config.ts settles) — the same pools `axon <ref>` resolves
 * against, so an agent you can run is one listed here. A project in two pools
 * is listed once.
 *
 * A directory is an agent when it declares itself one (`axon.config.ts`).
 * Anything else under `agents/` is somebody's stray folder, and listing it
 * would offer a Run button for something that cannot run.
 */
function scan(stores: readonly string[]): InstalledAgent[] {
    const found: InstalledAgent[] = []
    const seen = new Set<string>()
    for (const store of stores) {
        const profiles = join(store, "profiles")
        for (const profile of readDirs(profiles)) {
            const pools = [join(profiles, profile, "agents"), ...watched(join(profiles, profile))]
            for (const pool of pools) {
                for (const name of readDirs(pool)) {
                    const root = join(pool, name)
                    if (seen.has(root) || !existsSync(join(root, "axon.config.ts"))) continue
                    seen.add(root)
                    const declared = manifest(root)
                    found.push({
                        name: name,
                        // What the agent CALLS itself, which is what the CLI
                        // takes and what a person recognises.
                        ref: declared.name ?? name,
                        version: declared.version,
                        profile: profile,
                        root: root,
                        usedAt: usedAt(root),
                        definition: definition(root),
                    })
                }
            }
        }
    }
    // Most recently used first. A fleet list is a list of things you
    // might open again, and alphabetical order buries the one you
    // were just in behind nine you have never run.
    return found.sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || a.name.localeCompare(b.name))
}


/**
 * The folders a profile watches for agents, absolute: its settings' `paths`, read from its
 * profile.config.ts as the platform reads them (an AST read: nothing evaluated).
 */
function watched(profile: string): string[] {
    const paths = readSettingsSync(profile).paths
    if (paths === undefined) return []
    if (!Array.isArray(paths) || !paths.every(p => typeof p === "string"))
        throw err("FILE_UNREADABLE", { detail: `${profile}/profile.config.ts: settings.paths isn't a list of folders`, context: { path: join(profile, "profile.config.ts") } })
    return paths.map(p => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(profile, p)))
}

/**
 * Where agent projects live, for both distributions.
 *
 * BOTH, deliberately, and for the same reason the running registry scans both:
 * a developer has an installed CLI and a source build side by side, and a
 * fleet view that showed one of them would be describing half the machine.
 */
function storeRoots(): string[] {
    return [join(homedir(), ".axon"), join(homedir(), ".axon-dev")]
}

/**
 * The scoped name an agent declares for itself, e.g. `@axon/zeno`.
 *
 * From its `package.json`, which is where the name that `axon <ref>` resolves
 * actually lives. The DIRECTORY name is not it: `zeno` on its own is rejected
 * as an unknown command, because a bare word could be anything and the scope
 * belongs to whoever published it rather than to the folder someone cloned it
 * into.
 *
 * Null when there is no `package.json`, so the caller falls back to the
 * directory rather than this inventing a scope. One that exists but cannot be
 * read or parsed throws: a remote inventory must not show a broken agent as an
 * unscoped one.
 */
function manifest(root: string): { name: string | null; version: string | null } {
    const path = join(root, "package.json")
    let text: string
    try {
        text = readFileSync(path, "utf-8")
    } catch (cause) {
        if (absent(cause)) return { name: null, version: null }
        throw unreadable(path, cause)
    }
    let parsed: { name?: unknown; version?: unknown }
    try {
        parsed = JSON.parse(text) as { name?: unknown; version?: unknown }
    } catch (cause) {
        throw unreadable(path, cause)
    }
    return {
        name: typeof parsed.name === "string" && parsed.name !== "" ? parsed.name : null,
        version: typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : null,
    }
}

/**
 * The source files that define this agent, and ONLY the ones that are there.
 *
 * A detail view offers these as editor links, so a conventional path that
 * happens not to exist is a link that opens an empty buffer — the panel
 * claiming the agent has a `src/tools` it does not have. Existence is checked
 * here, where the directory is already being walked, rather than trusted from
 * the convention.
 *
 * `axon.config.ts` is always present: `installed()` uses it as the test for
 * whether a directory is an agent at all.
 */
function definition(root: string): DefinitionFile[] {
    const candidates: DefinitionFile[] = [
        { label: "Configuration", path: join(root, "axon.config.ts") },
        { label: "Boot", path: join(root, "src", "boot.vue") },
        { label: "Tools", path: join(root, "src", "tools") },
    ]
    return candidates.filter(entry => existsSync(entry.path))
}

/**
 * When an agent was last used, as far as the filesystem can say.
 *
 * Its session store, which is written on every exchange, falling back to the
 * project itself for one that has never run. Read from mtime rather than by
 * opening session files: recency is the only thing wanted here, and a
 * directory stat answers it without parsing anything.
 *
 * Null when neither can be read — absent is honest where a zero would sort a
 * working agent to the bottom.
 */
function usedAt(root: string): number | null {
    for (const path of [join(root, ".agent", "data"), root]) {
        try {
            return statSync(path).mtimeMs
        } catch (cause) {
            if (!absent(cause)) throw unreadable(path, cause)
        }
    }
    return null
}

/**
 * Subdirectories of a path, or nothing when it does not exist.
 *
 * Absent is the ordinary case — a machine with no profile has no agents, which
 * is a real answer. Anything else (permissions, I/O) throws: an inventory that
 * read as empty because the store could not be read would tell a remote caller
 * "no agents" about a machine that has them.
 */
function readDirs(path: string): string[] {
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
    } catch (cause) {
        if (absent(cause)) return []
        throw unreadable(path, cause)
    }
}

/** Whether a filesystem failure is the path not existing — the only one discovery treats as an answer. */
function absent(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

function unreadable(path: string, cause: unknown) {
    return err("FILE_UNREADABLE", {
        detail: `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
        context: { path: path },
        cause,
    })
}
