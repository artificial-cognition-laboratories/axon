import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
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

describe("agent project: publish()", () => {
    it("registers, uploads, and syncs visibility for a real agent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })

            const result = await project.publish()

            expect(result.name).toBe(name)
            expect(typeof result.registeredId).toBe("string")
            expect(result.version).toBe("0.1.0")
            expect(result.public).toBe(true)
            expect(
                (await platform.cloud.client.registry.agents.agent(result.registeredId).get())
                    .private
            ).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("uses package.json private:true as the source of truth", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })
            const pkgPath = join(project.root, "package.json")
            const pkg = JSON.parse(await Bun.file(pkgPath).text())
            pkg.private = true
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n")

            const result = await project.publish()
            expect(result.public).toBe(false)
            expect(
                (await platform.cloud.client.registry.agents.agent(result.registeredId).get())
                    .private
            ).toBe(true)
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
            const project = await platform.projects.create("agent", { name, dir })

            const result = await project.publish()
            const agent = platform.cloud.client.registry.agents.agent(result.registeredId)
            const versions = await agent.versions()

            expect(versions.find(v => v.version === "0.1.0")).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("a version collision auto-bumps the patch, rebuilds, and publishes", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })

            const first = await project.publish()
            const second = await project.publish()

            expect([first.version, second.version]).toEqual(["0.1.0", "0.1.1"])

            const pkg = JSON.parse(await Bun.file(join(project.root, "package.json")).text())
            const image = JSON.parse(
                await Bun.file(join(project.root, ".agent", "build", "image.json")).text()
            )
            expect(pkg.version).toBe("0.1.1")
            expect(image.version).toBe("0.1.1")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("bumping the version in package.json allows a second real publish", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("agent", { name, dir })

            await project.publish()

            const pkgPath = join(project.root, "package.json")
            const pkg = JSON.parse(await Bun.file(pkgPath).text())
            pkg.version = "0.2.0"
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))

            const second = await project.publish()

            expect(second.version).toBe("0.2.0")
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
            const project = await platform.projects.create("agent", { name, dir })

            await expect(project.publish()).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)
})
