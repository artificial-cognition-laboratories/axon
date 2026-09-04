import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * Retrieving a published artifact from the real registry.
 *
 * Deliberately end-to-end against staging: publish a module, then clone and
 * fork it back. The unit test beside this one stubs fetch and therefore proves
 * only that the extractor works on an archive we built ourselves — it cannot
 * catch a tarball shape the real publish path produces but the real clone path
 * mishandles, which is exactly the failure that once put a cloned module at
 * <target>/package/ and reported PROJECT_NOT_FOUND at a directory that looked
 * empty.
 */

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

/** Publish a real module and return its name — the fixture every case here clones. */
async function published(platform: ReturnType<typeof Platform>, dir: string): Promise<string> {
    const name = disposableName()
    const project = await platform.projects.create("module", { name, dir })
    await project.publish()
    return name
}

describe("registry clone/fork against the real registry", () => {
    it("clones a published module and prepares its authoring frame", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-clone-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const name = await published(platform, dir)

            const result = await platform.registry.clone(name, target)

            expect(result.name).toBe(name)
            expect(result.version).toBe("0.1.0")
            // The npm `package/` prefix is stripped — the project lands at the
            // root of the target, not one directory down.
            expect(existsSync(join(result.root, "module.config.ts"))).toBe(true)
            expect(existsSync(join(result.root, "package.json"))).toBe(true)
            // prepare() ran: the frame exists.
            expect(existsSync(join(result.root, ".module"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 120_000)

    it("a cloned project is openable — the clone is a real project, not just files", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-clone-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const name = await published(platform, dir)

            const result = await platform.registry.clone(name, target)
            const project = await platform.projects.open(result.root)

            expect(project.kind).toBe("module")
            expect(project.name).toBe(name)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 120_000)

    it("forks under a new identity, recording immutable provenance", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-fork-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const name = await published(platform, dir)
            const forkName = `@${TEST_USER.username}/forked-${crypto.randomUUID().slice(0, 8)}`

            const result = await platform.registry.fork(name, target, { as: forkName })

            const pkg = JSON.parse(await readFile(join(result.root, "package.json"), "utf-8"))
            expect(pkg.name).toBe(forkName)
            // A fork starts its own version history rather than inheriting one.
            expect(pkg.version).toBe("0.1.0")
            expect(pkg.axon.forkedFrom).toEqual({ name, version: "0.1.0" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 120_000)

    it("a fork is independently publishable under its new name", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-fork-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const name = await published(platform, dir)
            const forkName = `@${TEST_USER.username}/forked-${crypto.randomUUID().slice(0, 8)}`

            const forked = await platform.registry.fork(name, target, { as: forkName })
            const project = await platform.projects.open(forked.root)
            const result = await project.publish()

            expect(result.name).toBe(forkName)
            expect(result.version).toBe("0.1.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 120_000)

    it("refuses to clone into a directory that already has content", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-clone-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const name = await published(platform, dir)

            await platform.registry.clone(name, target)
            // Same target, same derived directory name — the second must refuse
            // rather than merge into a half-populated tree.
            await expect(platform.registry.clone(name, target))
                .rejects.toMatchObject({ code: "AX-PROJECT-025" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 120_000)

    it("refuses a fork with no new name — a fork must be publishable under its own identity", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-fork-"))

        try {
            const platform = await authenticatedPlatform(storeDir)

            await expect(platform.registry.fork("@axon/anything", target, {}))
                .rejects.toMatchObject({ code: "AX-PROJECT-024" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 30_000)

    it("refuses an unscoped specifier rather than asking the backend to resolve one", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const target = await mkdtemp(join(tmpdir(), "axon-test-clone-"))

        try {
            const platform = await authenticatedPlatform(storeDir)

            // The registry cannot hold an unscoped name, so this is refused
            // locally — clone used to carry its own laxer parser and asked the
            // backend to resolve something that cannot exist.
            await expect(platform.registry.clone("arxiv", target))
                .rejects.toMatchObject({ code: "AX-PROJECT-005" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(target, { recursive: true, force: true })
        }
    }, 30_000)
})
