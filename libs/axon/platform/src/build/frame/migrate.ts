import { readdir, rename, rm, mkdir, cp } from "node:fs/promises"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"
import { Frame, type ProjectKind } from "./frame"

/**
 * Migrating a project from the flat frame to the grouped one.
 *
 * The old frame was a single flat directory: axon.d.ts, tsconfig.json,
 * tools-declare-cache.json, Dockerfile, image.json and source.tar.gz all
 * siblings. The new one groups them (see FRAME in frame.ts). Every existing
 * project on every developer's machine has the old shape, so `prepare` must
 * convert it — silently, once, and without ever putting user data at risk.
 *
 * The strategy follows from the regenerable/irreplaceable split:
 *
 *   REGENERABLE (types, cache, build) — DELETED, not moved. Moving a stale
 *   .d.ts leaves it stale; prepare regenerates all of it moments later
 *   anyway. Deleting is both simpler and more correct than a careful move.
 *
 *   IRREPLACEABLE (data: sessions, state, sensory) — genuinely moved, with
 *   the care that implies. Session logs are user history; there is no
 *   regenerating them.
 *
 * Everything here is idempotent and safe to interrupt. A migration killed
 * halfway leaves a project that is partly converted, and re-running finishes
 * the job — which is why directories move one at a time, each with its own
 * move-then-delete, rather than as one bulk operation.
 */

/**
 * Files the OLD flat frame wrote directly into `.agent/`.
 *
 * Listed explicitly rather than "delete everything that is not a known
 * directory": the frame is created by us but lives in the user's project, and
 * a blanket delete of unrecognized files is how a tool destroys something it
 * did not put there. Anything not on this list is left alone.
 */
const FLAT_TYPES = [
    "axon.d.ts",
    "axon-test.d.ts",
    "axon-test.tsconfig.json",
    "tsconfig.json",
    "globals.d.ts",
    "tool-globals.d.ts",
    "prompts.d.ts",
    "scripts.d.ts",
    "components.d.ts",
    "env.d.ts",
    "hooks.d.ts",
]

const FLAT_CACHE = [
    "tools-declare-cache.json",
    "tools-bundle-cache.json",
]

const FLAT_BUILD = [
    "Dockerfile",
    ".dockerignore",
    "image.json",
    "source.tar.gz",
    "manifest.json",
    "axon.manifest.json",
]

/**
 * The module lock — the one regenerable file worth moving rather than
 * deleting. Technically prepare can rebuild it, but doing so forces a full
 * re-link of every source module, so the cheap move is the kinder default.
 */
const LOCK_FILE = "source-modules.lock.json"

/** Runtime output directories that move from `<root>/data` into the frame. */
const DATA_DIRS = ["sessions", "state", "sensory"]

/**
 * Whether a project still has the old flat frame.
 *
 * Keyed on a generated TYPE declaration sitting directly in the frame root.
 * That file is written by every framed kind and only ever by typegen, so its
 * presence at the top level is unambiguous evidence of the old layout — as
 * opposed to `Dockerfile` or `image.json`, which only some kinds ever write
 * and which a user could plausibly have put there.
 */
function isFlat(frameDir: string): boolean {
    return FLAT_TYPES.some(name => fsx.exists(join(frameDir, name)))
        || FLAT_CACHE.some(name => fsx.exists(join(frameDir, name)))
}

/** Delete a list of files from the flat frame. Absent files are already migrated. */
async function discard(frameDir: string, names: string[]): Promise<number> {
    let removed = 0
    for (const name of names) {
        const path = join(frameDir, name)
        if (!fsx.exists(path)) continue
        await rm(path, { recursive: true, force: true })
        removed += 1
    }
    return removed
}

/**
 * Move one directory, preferring rename and falling back to copy+delete.
 *
 * `rename` is atomic but fails with EXDEV when source and target sit on
 * different filesystems — which is the normal case when a project root is a
 * bind mount or a container volume. The fallback is copy-then-delete IN THAT
 * ORDER: an interrupt between the two leaves both copies, which re-running
 * resolves, whereas delete-first would lose the data outright.
 */
async function moveDir(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true })
    try {
        await rename(from, to)
        return
    } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : null
        if (code !== "EXDEV") throw error
    }

    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
}

/**
 * Move runtime output from `<root>/data/*` into `<root>/.agent/data/*`.
 *
 * `data/knowledge` is deliberately NOT in DATA_DIRS: it is author-owned
 * source that gets committed, and it stays at the project root. That split is
 * the point of the whole move — after it, everything under the frame is
 * disposable and everything the user wrote is outside it.
 *
 * Merges entry by entry, and refuses only on a real collision.
 *
 * The destination is routinely non-empty by the time this runs, and NOT
 * because anything went wrong: the runtime opens its build-log session at the
 * new path before `prepare` is called, so the very act of running `axon
 * prepare` on an unmigrated agent creates `.agent/data/sessions/<id>.jsonl`
 * first. Treating a populated destination as a conflict therefore failed
 * every agent that had ever run — the one case this most needed to handle.
 *
 * So the unit of conflict is a NAME, not a directory. Sessions are UUIDs and
 * state files are namespaced, so the two sides are disjoint in practice and
 * the merge is exact. A genuine same-name collision on both sides is the only
 * thing that cannot be resolved without choosing whose history to discard,
 * and that still throws having moved nothing.
 */
async function migrateData(root: string, frameDataDir: string): Promise<string[]> {
    const legacyRoot = join(root, "data")
    if (!fsx.exists(legacyRoot)) return []

    const moved: string[] = []
    for (const name of DATA_DIRS) {
        const from = join(legacyRoot, name)
        if (!fsx.exists(from)) continue

        const to = join(frameDataDir, name)
        if (!fsx.exists(to)) {
            await moveDir(from, to)
            moved.push(name)
            continue
        }

        // Both sides exist. Check every entry BEFORE moving any of them, so a
        // refusal leaves the tree exactly as it was found.
        const incoming = await readdir(from)
        const existing = new Set(await readdir(to))
        const collisions = incoming.filter(entry => existing.has(entry))
        if (collisions.length > 0) {
            throw err("FRAME_MIGRATION_CONFLICT", {
                detail: `${name}/ has ${collisions.length} entr${collisions.length === 1 ? "y" : "ies"} `
                    + `in both ${legacyRoot} and ${frameDataDir}: ${collisions.slice(0, 5).join(", ")}`,
                context: { from, to, root, collisions },
            })
        }

        for (const entry of incoming) {
            await moveDir(join(from, entry), join(to, entry))
        }
        await rm(from, { recursive: true, force: true })
        moved.push(name)
    }

    // Only if nothing is left. `data/knowledge` keeps the directory alive for
    // most agents, and an unexpected leftover is the user's file, not ours.
    if ((await readdir(legacyRoot)).length === 0) {
        await rm(legacyRoot, { recursive: true, force: true })
    }

    return moved
}

export type FrameMigration = {
    /** Whether anything was converted. False means the project was already current. */
    migrated: boolean
    /** Regenerable files discarded — prepare rewrites them in this same run. */
    discarded: number
    /** Runtime output directories physically moved into the frame. */
    dataMoved: string[]
}

/**
 * Convert a project's frame to the grouped layout, if it isn't already.
 *
 * Runs at the top of `prepare`, before typegen writes anything, so the
 * regenerable files it discards are rebuilt in the same run and the project
 * is never left without its types.
 */
export async function migrateFrame(root: string, kind: ProjectKind): Promise<FrameMigration> {
    const frame = Frame({ root: root, kind: kind })

    // A project with no frame at all is new, not old — nothing to convert.
    if (!fsx.exists(frame.dir)) {
        return { migrated: false, discarded: 0, dataMoved: [] }
    }

    const flat = isFlat(frame.dir)

    let discarded = 0
    if (flat) {
        discarded += await discard(frame.dir, FLAT_TYPES)
        discarded += await discard(frame.dir, FLAT_CACHE)
        discarded += await discard(frame.dir, FLAT_BUILD)

        const lock = join(frame.dir, LOCK_FILE)
        if (fsx.exists(lock)) {
            await mkdir(frame.path("cache"), { recursive: true })
            await moveDir(lock, frame.file("cache", LOCK_FILE))
        }
    }

    // Independent of the flat check: an agent can have been through a
    // types/cache/build migration already and still hold runtime output at
    // the old path, and a project that never had a frame still might.
    const dataMoved = kind === "agent"
        ? await migrateData(root, frame.path("data"))
        : []

    return {
        migrated: flat || dataMoved.length > 0,
        discarded: discarded,
        dataMoved: dataMoved,
    }
}
