import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"

/**
 * Publishing over a version that already exists.
 *
 * Published versions are immutable — the backend answers 409. Rather than
 * making the user bump by hand, publish() advances the patch in package.json,
 * REBUILDS so the tarball and registry metadata agree, and retries.
 *
 * The rebuild is the part worth asserting: skipping it would upload an artifact
 * whose image.json still claims the old version, which the registry would
 * happily accept and nobody would notice until an install resolved wrong.
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

describe("module project: publishing an existing version", () => {
    it("auto-bumps the patch and publishes the next version", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const first = await project.publish()
            expect(first.version).toBe("0.1.0")

            // Nothing changed on disk — the version it would publish is taken.
            const second = await project.publish()

            expect(second.version).toBe("0.1.1")
            expect(second.name).toBe(name)
            expect(second.registeredId).toBe(first.registeredId)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("persists the bump to package.json — the next publish starts from the new version", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            await project.publish()
            await project.publish()

            const pkg = JSON.parse(await readFile(join(project.root, "package.json"), "utf-8"))
            expect(pkg.version).toBe("0.1.1")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("rebuilds after the bump so the artifact agrees with what was registered", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            await project.publish()
            const result = await project.publish()

            // image.json is written by the bundler, not the publisher. If the
            // retry uploaded a stale build, this would still read 0.1.0 while
            // the registry recorded 0.1.1.
            const image = JSON.parse(await readFile(join(project.root, ".module", "build", "image.json"), "utf-8"))
            expect(image.version).toBe(result.version)
            expect(image.moduleId).toBe(name)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("bumps repeatedly — three publishes of an unchanged module yield three versions", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = await authenticatedPlatform(storeDir)
            const project = await platform.projects.create("module", { name, dir })

            const versions = [
                (await project.publish()).version,
                (await project.publish()).version,
                (await project.publish()).version,
            ]

            expect(versions).toEqual(["0.1.0", "0.1.1", "0.1.2"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 90_000)
})
