import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

/** A Platform() whose store already has TEST_USER's real API key persisted — Cloud() picks it up at construction. */
async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })

    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

describe("module project: publish()", () => {
    it("registers, uploads, and syncs visibility for a real module", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const result = await project.publish()

            expect(result.name).toBe(name)
            expect(typeof result.registeredId).toBe("string")
            expect(result.version).toBe("0.1.0")
            // scaffolded modules declare private:false in package.json — public
            expect(result.public).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("the published version is visible via the real registry", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const result = await project.publish()
            const module_ = platform.cloud.client.registry.artifacts.artifact(result.registeredId)
            const versions = await module_.versions()

            expect(versions.find(v => v.version === "0.1.0")).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("a version collision auto-bumps the patch, writes it back, and retries once", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const first = await project.publish()
            expect(first.version).toBe("0.1.0")

            // Same on-disk version (0.1.0) again — this collides server-side,
            // so publish() should auto-bump to 0.1.1 and retry, not throw.
            const second = await project.publish()
            expect(second.version).toBe("0.1.1")

            const pkg = JSON.parse(await Bun.file(join(project.root, "package.json")).text())
            expect(pkg.version).toBe("0.1.1")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("repeated collisions keep bumping the patch each time", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const first = await project.publish()
            const second = await project.publish()
            const third = await project.publish()

            expect([first.version, second.version, third.version]).toEqual(["0.1.0", "0.1.1", "0.1.2"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("public becomes true once package.json's private flag is removed, reflected in the registry", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const pkgPath = join(project.root, "package.json")
            const pkg = JSON.parse(await Bun.file(pkgPath).text())
            delete pkg.private
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))

            const result = await project.publish()
            expect(result.public).toBe(true)

            const module_ = platform.cloud.client.registry.artifacts.artifact(result.registeredId)
            const record = await module_.get()
            expect(record.private).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("requires auth — an unauthenticated Platform({ version: TEST_VERSION }) fails to publish", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await expect(project.publish()).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)
})
