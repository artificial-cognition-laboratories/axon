import { writeFile } from "node:fs/promises"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"

export type LockEntry = {
    /** Absolute path to the module root at prepare time (machine-local, informational only). */
    sourcePath: string
    /** SHA-256 hex digest over module.config.ts + package.json + src/. */
    contentHash: string
}

export type LockFile = {
    lockfileVersion: 1
    modules: Record<string, LockEntry>
}

const FILE = "source-modules.lock.json"

type LockOpts = {
    root: string
}

/**
 * Lock — .agent/cache/source-modules.lock.json.
 *
 * A source module has no semver of its own, so its version identity is a
 * content hash of what was on disk at prepare time. This records that, which
 * is what lets a deployment later answer "which cut of this local module
 * shipped" and lets prepare answer "did it change since last time".
 *
 * Keyed by SHORT name (the name the blueprint scanner uses), not by package
 * name — callers pruning by package name must map across, which prune() does.
 */
export function Lock(opts: LockOpts) {
    // The lock is a cache in the strict sense — it records what prepare
    // already did so the next prepare can skip it — so it lives with the
    // other caches rather than loose in the frame root.
    const frame = Frame({ root: opts.root, kind: "agent" })
    const path = frame.file("cache", FILE)

    async function read(): Promise<LockFile> {
        return (await fsx.readJson<LockFile>(path)) ?? { lockfileVersion: 1, modules: {} }
    }

    async function write(lock: LockFile): Promise<void> {
        frame.ensure("cache")
        await writeFile(path, JSON.stringify(lock, null, 2) + "\n")
    }

    return {
        path: path,
        read: read,

        /** The hash recorded for this module at the last prepare, if any. */
        async recorded(name: string): Promise<string | undefined> {
            return (await read()).modules[name]?.contentHash
        },

        /** Record a module's current identity. */
        async record(name: string, entry: LockEntry): Promise<void> {
            const lock = await read()
            lock.modules[name] = entry
            await write(lock)
        },

        /** Drop entries by short name. */
        async forget(names: string[]): Promise<void> {
            const lock = await read()
            const dead = new Set(names)
            for (const key of Object.keys(lock.modules)) {
                if (dead.has(key)) delete lock.modules[key]
            }
            await write(lock)
        },
    }
}

export type LockT = ReturnType<typeof Lock>
