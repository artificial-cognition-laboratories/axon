import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, symlink, readdir, readlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeCache } from "@arcforge/platform/build/project"

/**
 * TreeCache — resolved dependency trees, shared machine-wide.
 *
 * This was the highest-risk code in the install path and it had ZERO tests:
 * ~200 lines of shared mutable state, LRU eviction, symlink grafting and
 * content hashing, reachable only through a full `bun install` against a
 * hardcoded ~/.axon. It also caused half of this system's dependency
 * incidents — eviction deleted a tree a live project was grafted onto, and
 * every package in that project went dangling at once, reported to the user
 * as a missing cognet.
 *
 * The invariants below are ranked by what a violation COSTS:
 *
 *   evicting a referenced tree   → a silently broken project (worst)
 *   a wrong key HIT              → the wrong dependencies installed
 *   a wrong key MISS             → a slow reinstall (cheap, acceptable)
 *   a failed publish             → a slow reinstall (cheap, acceptable)
 *
 * So the eviction and key tests are the load-bearing ones, and everything
 * about failure handling asserts "degrades to slow", never "degrades to wrong".
 */

/** A staging directory shaped like the input `publish` expects. */
async function staging(files: {
    dependencies?: Record<string, string>
    overrides?: Record<string, string>
    bunfig?: string
    lock?: string
    modules?: Record<string, string>
}) {
    const dir = await mkdtemp(join(tmpdir(), "axon-staging-"))
    await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
            name: "probe",
            version: "1.0.0",
            dependencies: files.dependencies ?? {},
            ...(files.overrides ? { overrides: files.overrides } : {}),
        }),
        "utf8",
    )
    if (files.bunfig !== undefined) await writeFile(join(dir, "bunfig.toml"), files.bunfig, "utf8")
    if (files.lock !== undefined) await writeFile(join(dir, "bun.lock"), files.lock, "utf8")

    await mkdir(join(dir, "node_modules"), { recursive: true })
    for (const [name, version] of Object.entries(files.modules ?? { "@t/a": "1.0.0" })) {
        const pkg = join(dir, "node_modules", ...name.split("/"))
        await mkdir(pkg, { recursive: true })
        await writeFile(join(pkg, "package.json"), JSON.stringify({ name, version }), "utf8")
    }
    return dir
}

async function cacheIn(max?: number) {
    const root = await mkdtemp(join(tmpdir(), "axon-treecache-"))
    return {
        root,
        cache: TreeCache({ root, ...(max !== undefined ? { max } : {}) }),
        cleanup: () => rm(root, { recursive: true, force: true }),
    }
}

describe("key: equal inputs mean equal trees", () => {
    test("two projects with identical dependencies share a key", async () => {
        // The whole point of the cache. Including project identity (name,
        // version) made every project unique, so the cache never hit at all.
        const { cache, cleanup } = await cacheIn()
        const a = await staging({ dependencies: { "@t/a": "^1.0.0" } })
        const b = await staging({ dependencies: { "@t/a": "^1.0.0" } })
        try {
            expect(await cache.key(a)).toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("dependency ORDER does not change the key", async () => {
        const { cache, cleanup } = await cacheIn()
        const a = await staging({ dependencies: { "@t/a": "^1.0.0", "@t/b": "^2.0.0" } })
        const b = await staging({ dependencies: { "@t/b": "^2.0.0", "@t/a": "^1.0.0" } })
        try {
            expect(await cache.key(a)).toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("a different RANGE is a different key", async () => {
        const { cache, cleanup } = await cacheIn()
        const a = await staging({ dependencies: { "@t/a": "^1.0.0" } })
        const b = await staging({ dependencies: { "@t/a": "^2.0.0" } })
        try {
            expect(await cache.key(a)).not.toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("a different REGISTRY is a different key", async () => {
        // The same range against a different registry resolves to different
        // bytes — the staging-vs-production split that poisoned a manifest.
        const { cache, cleanup } = await cacheIn()
        const a = await staging({ dependencies: { "@t/a": "^1.0.0" }, bunfig: 'url = "https://prod"' })
        const b = await staging({ dependencies: { "@t/a": "^1.0.0" }, bunfig: 'url = "http://localhost:3099"' })
        try {
            expect(await cache.key(a)).not.toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("a different LOCKFILE pin is a different key", async () => {
        const { cache, cleanup } = await cacheIn()
        const a = await staging({ dependencies: { "@t/a": "^1.0.0" }, lock: '{"packages":{"@t/a":["@t/a@1.0.0"]}}' })
        const b = await staging({ dependencies: { "@t/a": "^1.0.0" }, lock: '{"packages":{"@t/a":["@t/a@1.0.4"]}}' })
        try {
            expect(await cache.key(a)).not.toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("the lockfile's own identity block does NOT change the key", async () => {
        // `workspaces[""]` is the project restating its own name and version —
        // identity, not resolution. Hashing it made every project unique.
        const { cache, cleanup } = await cacheIn()
        const resolution = '"packages":{"@t/a":["@t/a@1.0.0"]}'
        const a = await staging({ dependencies: { "@t/a": "^1.0.0" }, lock: `{"workspaces":{"":{"name":"alpha"}},${resolution}}` })
        const b = await staging({ dependencies: { "@t/a": "^1.0.0" }, lock: `{"workspaces":{"":{"name":"beta"}},${resolution}}` })
        try {
            expect(await cache.key(a)).toBe((await cache.key(b))!)
        } finally { await Promise.all([cleanup(), rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]) }
    })

    test("a staging dir with no manifest has no key", async () => {
        // No key means no hit and no store — never a guess.
        const { cache, cleanup } = await cacheIn()
        const empty = await mkdtemp(join(tmpdir(), "axon-empty-"))
        try {
            expect(await cache.key(empty)).toBeNull()
        } finally { await Promise.all([cleanup(), rm(empty, { recursive: true, force: true })]) }
    })
})

describe("publish: an entry is complete or absent", () => {
    test("stores the tree under its key", async () => {
        const { cache, root, cleanup } = await cacheIn()
        const dir = await staging({ modules: { "@t/a": "1.0.0" } })
        try {
            const key = (await cache.key(dir))!
            await cache.publish(key, dir)
            expect(existsSync(join(root, key, "node_modules", "@t", "a"))).toBe(true)
        } finally { await Promise.all([cleanup(), rm(dir, { recursive: true, force: true })]) }
    })

    test("publishing the same key twice is a no-op, not a corruption", async () => {
        // Two workers resolving the same manifest both publish; the rename
        // makes the loser's write a no-op rather than a half-written tree.
        const { cache, cleanup } = await cacheIn()
        const dir = await staging({})
        try {
            const key = (await cache.key(dir))!
            await cache.publish(key, dir)
            await cache.publish(key, dir)
            expect(await cache.list()).toEqual([key])
        } finally { await Promise.all([cleanup(), rm(dir, { recursive: true, force: true })]) }
    })

    test("leaves no .pending directory behind", async () => {
        // A visible half-copied entry is the thing the rename exists to avoid.
        const { cache, cleanup } = await cacheIn()
        const dir = await staging({})
        try {
            await cache.publish((await cache.key(dir))!, dir)
            const listed = await cache.list()
            expect(listed.some(name => name.includes("pending"))).toBe(false)
        } finally { await Promise.all([cleanup(), rm(dir, { recursive: true, force: true })]) }
    })

    test("resolves ABSOLUTE links, which would dangle once staging is deleted", async () => {
        // An absolute link points into the staging dir the caller is about to
        // delete. Storing one would hand every future project a dead path —
        // the exact shape of the incident this cache caused.
        const { cache, root, cleanup } = await cacheIn()
        const dir = await staging({ modules: { "@t/real": "1.0.0" } })
        try {
            const target = join(dir, "node_modules", "@t", "real")
            await symlink(target, join(dir, "node_modules", "absolute-link"))

            const key = (await cache.key(dir))!
            await cache.publish(key, dir)
            await rm(dir, { recursive: true, force: true })

            // The stored entry must still resolve with staging gone.
            expect(existsSync(join(root, key, "node_modules", "absolute-link"))).toBe(true)
        } finally { await Promise.all([cleanup(), rm(dir, { recursive: true, force: true })]) }
    })
})

describe("eviction: never delete a tree something is using", () => {
    async function publishN(cache: ReturnType<typeof TreeCache>, count: number): Promise<string[]> {
        const keys: string[] = []
        for (let index = 0; index < count; index += 1) {
            const dir = await staging({ dependencies: { [`@t/pkg${index}`]: "^1.0.0" } })
            const key = (await cache.key(dir))!
            await cache.publish(key, dir)
            keys.push(key)
            await rm(dir, { recursive: true, force: true })
        }
        return keys
    }

    test("evicts down to the budget once it is exceeded", async () => {
        const { cache, cleanup } = await cacheIn(3)
        try {
            await publishN(cache, 5)
            expect((await cache.list()).length).toBeLessThanOrEqual(3)
        } finally { await cleanup() }
    })

    test("NEVER evicts a tree a project still points at", async () => {
        // THE INCIDENT. A referenced tree deleted does not cost a reinstall —
        // it leaves that project's node_modules full of dangling links, which
        // every resolver reports as "package not installed" and which no
        // amount of re-running fixes.
        const { cache, root, cleanup } = await cacheIn(2)
        const project = await mkdtemp(join(tmpdir(), "axon-project-"))
        try {
            const [first] = await publishN(cache, 1)

            // Graft the project onto it, exactly as Tree does on a cache hit.
            const treeModules = join(root, first!, "node_modules")
            const projectModules = join(project, "node_modules")
            await mkdir(projectModules, { recursive: true })
            for (const entry of await readdir(treeModules)) {
                await symlink(join(treeModules, entry), join(projectModules, entry))
            }
            await cache.addReferrer(join(root, first!), project)

            // Now push well past the budget with unrelated trees.
            await publishN(cache, 5)

            expect(await cache.list()).toContain(first!)
            // And the project still resolves through it.
            const [linked] = await readdir(projectModules)
            expect(existsSync(join(projectModules, linked!))).toBe(true)
        } finally { await Promise.all([cleanup(), rm(project, { recursive: true, force: true })]) }
    })

    test("a referrer whose project is GONE does not pin the tree forever", async () => {
        // Referrers are verified, not trusted — otherwise a deleted project
        // would pin an entry in the cache permanently.
        const { cache, root, cleanup } = await cacheIn(2)
        const project = await mkdtemp(join(tmpdir(), "axon-project-"))
        try {
            const [first] = await publishN(cache, 1)
            await cache.addReferrer(join(root, first!), project)
            await rm(project, { recursive: true, force: true })

            expect(await cache.isReferenced(join(root, first!))).toBe(false)
        } finally { await Promise.all([cleanup(), rm(project, { recursive: true, force: true })]) }
    })

    test("a referrer that no longer links HERE does not pin the tree", async () => {
        // The project exists but was reinstalled onto a different tree. A
        // stale entry must not keep the old one alive.
        const { cache, root, cleanup } = await cacheIn(4)
        const project = await mkdtemp(join(tmpdir(), "axon-project-"))
        try {
            const [first] = await publishN(cache, 1)
            await mkdir(join(project, "node_modules"), { recursive: true })
            await symlink(join(tmpdir(), "somewhere-else"), join(project, "node_modules", "@t"))
            await cache.addReferrer(join(root, first!), project)

            expect(await cache.isReferenced(join(root, first!))).toBe(false)
        } finally { await Promise.all([cleanup(), rm(project, { recursive: true, force: true })]) }
    })

    test("evicts the COLDEST entry, judged by use rather than write time", async () => {
        // Reading a tree does not touch its mtime, so eviction by mtime would
        // discard the most-reused tree on the machine for being oldest.
        const { cache, root, cleanup } = await cacheIn(2)
        try {
            const keys = await publishN(cache, 2)
            // Use the FIRST one; the second stays cold.
            await Bun.sleep(10)
            await cache.touch(join(root, keys[0]!))
            await publishN(cache, 1)

            expect(await cache.list()).toContain(keys[0]!)
        } finally { await cleanup() }
    })
})

describe("a broken cache degrades to slow, never to wrong", () => {
    test("an unwritable cache root does not throw", async () => {
        // The cache is an optimization with an authoritative fallback: the
        // real install already ran. A full or read-only home must slow the
        // build down, not break it.
        const cache = TreeCache({ root: "/proc/nonexistent/cannot-write-here" })
        const dir = await staging({})
        try {
            const key = (await cache.key(dir))!
            await cache.publish(key, dir)
            expect(await cache.list()).toEqual([])
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("listing a cache that does not exist yet is empty, not an error", async () => {
        const cache = TreeCache({ root: join(tmpdir(), `axon-never-created-${crypto.randomUUID()}`) })
        expect(await cache.list()).toEqual([])
    })

    test("isReferenced on an entry with no referrer file is false", async () => {
        // An entry from before this bookkeeping existed. Treated as
        // unreferenced, which is the pre-existing behaviour.
        const { cache, root, cleanup } = await cacheIn()
        try {
            const dir = join(root, "entry-with-no-referrers")
            await mkdir(dir, { recursive: true })
            expect(await cache.isReferenced(dir)).toBe(false)
        } finally { await cleanup() }
    })
})
