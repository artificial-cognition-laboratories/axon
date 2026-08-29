import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })

    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
}

describe("installer: per-specifier error isolation", () => {
    /**
     * A name that isn't in the registry is a miss, not a fault — the user
     * mistyped or the package was never published. "not-found" keeps it
     * distinct from "error" (network, disk, a broken tarball) so the UI can
     * report it as information rather than rendering a crash card.
     */
    it("an unresolvable specifier returns not-found rather than throwing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const results = await agent.modules.install(["@nonexistent-scope/totally-not-a-real-module"])

            expect(results).toHaveLength(1)
            expect(results[0]?.status).toBe("not-found")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 15_000)

    it("one bad specifier does not prevent the others in the same call from installing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const results = await agent.modules.install([
                "@nonexistent-scope/totally-not-a-real-module",
                published.name,
            ])

            expect(results).toHaveLength(2)
            expect(results[0]?.status).toBe("not-found")
            expect(results[1]).toEqual({ status: "installed", name: published.name, version: "0.1.0" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("still records the successful specifiers when one in the batch failed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install(["@nonexistent-scope/nope", published.name])

            const declared = await agent.modules.installed()
            expect(declared[published.name]).toBe("^0.1.0")
            expect(declared["@nonexistent-scope/nope"]).toBeUndefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)
})
