import { join } from "node:path"
import { homedir } from "node:os"
import { cp, mkdir, mkdtemp, readdir, readlink, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolveAbsoluteLinks } from "./links"

/**
 * TreeCache — resolved dependency trees, shared machine-wide.
 *
 * Extracted from Tree so it can be TESTED. It was ~200 lines of the
 * highest-risk code in the install path — shared mutable state, LRU eviction,
 * symlink grafting, content hashing — reachable only through a full `bun
 * install` against a hardcoded `~/.axon` path, and it had zero tests. It also
 * caused half the dependency incidents this system has had: eviction deleted a
 * tree a live project was grafted onto, and every package in that project went
 * dangling at once.
 *
 * `root` is injectable for exactly that reason. A test must never be able to
 * evict a developer's real cache, and a cache that can only be exercised
 * through the real one will not be exercised at all.
 *
 * Safe to delete at any time: a miss just does the install.
 */

export type TreeCacheOpts = {
    /** Where entries live. Defaults to ~/.axon/cache/trees. Tests inject a temp dir. */
    root?: string
    /** How many entries to keep. Tests shrink it to make eviction observable. */
    max?: number
}

export const DEFAULT_TREE_CACHE = join(homedir(), ".axon", "cache", "trees")
export const DEFAULT_MAX_TREES = 24

export function TreeCache(opts: TreeCacheOpts = {}) {
    const cacheRoot = opts.root ?? DEFAULT_TREE_CACHE
    const maxTrees = opts.max ?? DEFAULT_MAX_TREES


    /**
     * Where resolved dependency trees are kept, machine-wide.
     *
     * Beside bun's own install cache rather than in the project, because the
     * whole point is that unrelated projects with the same dependencies share
     * one resolution. Safe to delete at any time — a miss just does the install.
     */


    /**
     * Newline-delimited project roots whose node_modules symlink into this tree.
     *
     * Dot-prefixed so it is filtered out of the cache listing alongside `.used`.
     */
    const REFERRERS_FILE = ".referrers"

    /**
     * The cache key: a hash of everything the install reads.
     *
     * package.json carries the rebased dependency set, bunfig.toml the registry
     * mapping, and bun.lock the pin deciding which versions those ranges collapse
     * to. Together they are everything the install reads, so equal keys mean equal
     * trees.
     *
     * Each is stripped of the project's own IDENTITY before hashing. A package's
     * name and version sit in its manifest and are echoed into its lockfile, but
     * they do not change what it depends on — and including them made every
     * project a unique key, so two agents with byte-identical dependencies missed
     * each other's entries and the cache never hit at all.
     *
     * `file:` dependencies are the one input whose CONTENT can change without the
     * manifest moving — a local checkout is edited in place. They are hashed by
     * path only, deliberately: they are symlinked or copied in from that live
     * checkout on every install anyway, so a stale cache entry cannot hide an
     * edit to one.
     */
    async function treeKey(staging: string): Promise<string | null> {
        const manifest = Bun.file(join(staging, "package.json"))
        if (!(await manifest.exists())) return null

        const declared = JSON.parse(await manifest.text()) as {
            dependencies?: Record<string, string>
            overrides?: Record<string, string>
        }

        const hash = new Bun.CryptoHasher("sha256")
        hash.update(JSON.stringify(sortedEntries(declared.dependencies)))
        hash.update(JSON.stringify(sortedEntries(declared.overrides)))

        // The registry mapping decides WHERE those ranges resolve from — the same
        // range against a different registry is a different tree.
        const bunfig = Bun.file(join(staging, "bunfig.toml"))
        if (await bunfig.exists()) hash.update(await bunfig.arrayBuffer())

        // The pin. Its `workspaces[""]` block is the project restating its own
        // name/version/dependencies, which is identity rather than resolution —
        // dropped so two projects that resolved to the same versions share an
        // entry. What remains ("packages", and any overrides) is the resolution
        // itself.
        const lock = Bun.file(join(staging, "bun.lock"))
        if (await lock.exists()) {
            const text = await lock.text()
            try {
                const { workspaces: _identity, ...resolution } = JSON.parse(text) as Record<string, unknown>
                hash.update(JSON.stringify(resolution))
            } catch {
                // bun.lock is JSONC (trailing commas) and may not parse as strict
                // JSON. Hashing it whole is the conservative fallback: it can only
                // cost a miss, never a wrong hit.
                hash.update(text)
            }
        }

        return hash.digest("hex").slice(0, 32)
    }

    /** Key-stable form of a dependency map — object order must not change the hash. */
    function sortedEntries(record: Record<string, string> | undefined): Array<[string, string]> {
        return Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    }

    /**
     * How many resolved trees the cache keeps.
     *
     * Bounded by COUNT rather than bytes, because a tree's size is not knowable
     * without walking it — ~1400 files each, and stat'ing every one of them on
     * every publish would cost more than the copy the cache exists to avoid.
     * Count is a proxy the filesystem answers in one readdir.
     *
     * 24 entries is roughly 1–2GB at observed sizes (18MB median, 69MB worst),
     * and comfortably more distinct dependency sets than one machine works on
     * at once — the resident set is a handful of agents plus whatever the test
     * suite builds. Overshooting the budget costs disk; undershooting costs a
     * reinstall, which is slow but always correct.
     */


    /**
     * Mark an entry as used, so eviction can tell hot from cold.
     *
     * A `.used` file rather than the directory's own mtime: reading a tree
     * (which is all a cache hit does) does not touch mtime on any platform, so
     * mtime records when an entry was WRITTEN and would evict by age rather
     * than by use — throwing away the tree every project on the machine shares
     * because it happened to be resolved first.
     *
     * Best-effort by the same rule as everything else here: a cache that cannot
     * record a touch still serves the tree.
     */
    async function touchTree(dir: string): Promise<void> {
        await Bun.write(join(dir, ".used"), "").catch(() => {})
    }

    /**
     * Evict the coldest entries until the cache is within maxTrees.
     *
     * Called after a publish, never before: the entry just written is the one
     * most likely to be read next, so it must be present and touched before
     * anything is chosen for removal.
     *
     * Entries whose `.used` cannot be read sort oldest — an entry from before
     * this bookkeeping existed (every entry on an upgraded machine) has no
     * marker, and treating it as cold is right: it is genuinely unknown
     * whether anything still wants it, and a wrong guess costs one reinstall.
     *
     * Swallows failures for the same reason publishTree does: the cache is an
     * optimization with an authoritative fallback, and a full or read-only home
     * must never break a build.
     */
    async function evictTrees(): Promise<void> {
        try {
            const names = (await readdir(cacheRoot)).filter(name => !name.startsWith("."))
            if (names.length <= maxTrees) return

            const entries = await Promise.all(names.map(async name => ({
                name,
                usedAt: await Bun.file(join(cacheRoot, name, ".used")).stat()
                    .then(info => info.mtimeMs)
                    .catch(() => 0),
            })))

            entries.sort((a, b) => a.usedAt - b.usedAt)

            // Coldest first, but never a tree a project is still pointing at.
            // Deleting one of those does not cost a reinstall — it leaves that
            // project's node_modules full of dangling symlinks, which every
            // resolver reports as "package not installed" and no amount of
            // re-running fixes without a full reinstall.
            //
            // The budget can therefore be exceeded, deliberately: maxTrees bounds
            // disk, and disk is recoverable where a silently broken agent is not.
            // In practice referenced trees ARE the working set, so the overshoot is
            // bounded by how many projects exist on the machine.
            let over = entries.length - maxTrees
            for (const entry of entries) {
                if (over <= 0) break
                const dir = join(cacheRoot, entry.name)
                if (await isReferenced(dir)) continue
                await rm(dir, { recursive: true, force: true }).catch(() => {})
                over -= 1
            }
        } catch {
            // An unreadable cache directory is not a build failure.
        }
    }

    /**
     * Store a resolved tree under its key, atomically.
     *
     * Built beside the cache and then renamed in, so a reader either sees no
     * entry or a complete one — never a directory still being copied into. Two
     * workers resolving the same manifest at once both publish; the rename makes
     * the loser's write a no-op rather than a corruption, which is why the EEXIST
     * path is ignored rather than retried.
     *
     * Every failure here is swallowed on purpose, and it is the one place in this
     * file where that is right: the cache is an optimization with an authoritative
     * fallback one line below (the real install already ran). A full disk or a
     * read-only home must slow the build down, not break it.
     */
    async function publishTree(key: string, staging: string): Promise<void> {
        const final = join(cacheRoot, key)
        // Already published by an earlier build or a concurrent worker. Still a
        // use — without this the entry keeps its original write time forever and
        // eventually sorts oldest despite being the most reused tree on the box.
        if (existsSync(final)) return touchTree(final)

        let pending: string | null = null
        try {
            await mkdir(cacheRoot, { recursive: true })
            pending = await mkdtemp(join(cacheRoot, `.pending-${key}-`))
            // verbatimSymlinks, NOT dereference: bun's isolated linker keeps one
            // real copy of each package under `node_modules/.bun/` and makes every
            // other appearance a symlink into it. Dereferencing flattens the
            // top-level links but silently drops packages that are only reachable
            // through a nested one (`hookable`, reached via .bun/h3@…/node_modules),
            // producing a tree that resolves until something imports them.
            // Preserving the links keeps the layout bun actually built.
            // Same split as materialize(): keep the relative links bun's isolated
            // linker built (they stay valid inside the tree and are most of its
            // size), resolve the absolute ones. Here it is load-bearing rather
            // than merely faster — an absolute link points into the staging
            // directory this function is about to delete, and a cached entry
            // holding one would hand every future project a dangling path.
            await cp(join(staging, "node_modules"), join(pending, "node_modules"), { recursive: true, verbatimSymlinks: true })
            await resolveAbsoluteLinks(join(pending, "node_modules"))
            const lock = join(staging, "bun.lock")
            if (existsSync(lock)) await cp(lock, join(pending, "bun.lock"))
            await rename(pending, final)
            pending = null
            // Touch before evicting: the entry just published is the one most
            // likely to be read next, and must never be the one chosen.
            await touchTree(final)
            await evictTrees()
        } catch {
            // Lost the rename race, or the cache is unwritable. Either way the
            // caller has a valid tree in staging and proceeds unaffected.
        } finally {
            if (pending) await rm(pending, { recursive: true, force: true }).catch(() => {})
        }
    }

    /**
     * Symlink the dependencies declared with a local protocol.
     *
     * They were withheld from the isolated install (see above), so the
     * materialized tree has no copy of them. A symlink is deliberate rather than
     * a copy: the point of pointing an agent at a local checkout is that edits to
     * that checkout are live, which a copy would defeat.
     *
     * `workspace:*` resolves by walking up for the workspace root and finding the
     * package by name; `file:` carries its own path.
     */

    /**
     * Record that a project's node_modules now points into a cached tree.
     *
     * Eviction reads these to avoid deleting a tree something still depends on.
     * A grafted project holds NOTHING but symlinks into the cache, so removing
     * its tree does not slow it down — it breaks it outright, leaving a
     * node_modules full of dangling links that every resolver reports as "package
     * not installed". That is the failure this exists to prevent: an unrelated
     * project's install pushed the cache past maxTrees and silently unmade a
     * working agent, which then reported a missing cognet and sent the user
     * looking for a typo in their config.
     *
     * Best-effort, like everything else about the cache: a referrer that cannot be
     * recorded costs a wrongly-evicted tree (one reinstall), never a broken write.
     */
    async function addReferrer(treeDir: string, projectRoot: string): Promise<void> {
        try {
            const path = join(treeDir, REFERRERS_FILE)
            const existing = await Bun.file(path).text().then(
                text => text.split("\n").filter(Boolean),
                () => [] as string[],
            )
            if (existing.includes(projectRoot)) return
            await Bun.write(path, [...existing, projectRoot].join("\n"))
        } catch {
            // A cache that cannot record a referrer still serves the tree.
        }
    }

    /**
     * Is any project still pointing its node_modules into this tree?
     *
     * Referrers are verified rather than trusted: a project can be deleted, moved,
     * or reinstalled onto a different tree, and a stale entry would pin an entry
     * in the cache forever. The check is what makes the list self-cleaning — a
     * referrer whose node_modules no longer resolves into THIS tree does not count.
     */
    async function isReferenced(treeDir: string): Promise<boolean> {
        try {
            const listed = await Bun.file(join(treeDir, REFERRERS_FILE)).text()
            for (const projectRoot of listed.split("\n").filter(Boolean)) {
                const modules = join(projectRoot, "node_modules")
                let entries: string[]
                try {
                    entries = await readdir(modules)
                } catch {
                    continue // project gone, or has no node_modules any more
                }
                for (const entry of entries) {
                    const link = await readlink(join(modules, entry)).catch(() => null)
                    if (link?.startsWith(`${treeDir}/`)) return true
                }
            }
        } catch {
            // No referrer file — an entry from before this bookkeeping existed.
            // Treated as unreferenced, which is the pre-existing behaviour.
        }
        return false
    }


    return {
        root: cacheRoot,
        key: treeKey,
        publish: publishTree,
        touch: touchTree,
        evict: evictTrees,
        addReferrer: addReferrer,
        isReferenced: isReferenced,
        /** Entry directory for a key, whether or not it exists. */
        entry: (key: string) => join(cacheRoot, key),
        /** Every entry currently cached, newest-agnostic. */
        async list(): Promise<string[]> {
            try {
                return (await readdir(cacheRoot)).filter(name => !name.startsWith("."))
            } catch {
                return []
            }
        },
    }
}

export type TreeCacheT = ReturnType<typeof TreeCache>
