import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

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

describe("installer: already-installed", () => {
    it("re-installing the same specifier at the same version is a no-op", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const first = await agent.modules.install([published.name])
            expect(first[0]?.status).toBe("installed")

            const second = await agent.modules.install([published.name])
            expect(second[0]).toEqual({ status: "already-installed", name: published.name, version: "0.1.0" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("a fresh Installer instance (new Platform/Project) still recognizes the existing install", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agentName = disposableName("agent")
            const firstAgent = await platform.projects.create("agent", { name: agentName, dir: agentDir })
            await firstAgent.modules.install([published.name])

            // Re-open the same project fresh — a new Project()/Installer() instance, same disk state.
            const reopenedAgent = await platform.projects.open(firstAgent.root)
            const result = await reopenedAgent.modules.install([published.name])

            expect(result[0]?.status).toBe("already-installed")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)
})
