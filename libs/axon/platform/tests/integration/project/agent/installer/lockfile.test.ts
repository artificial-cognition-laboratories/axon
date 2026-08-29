import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"

/**
 * What an install leaves on disk. Axon owns the two declarations
 * (package.json = presence, axon.config.ts = activation); Bun owns
 * bun.lock and node_modules. These assert the Axon half plus the fact
 * that Bun's half actually materialized.
 */

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

describe("installer: what an install records", () => {
    it("declares nothing before anything is installed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK_PUBLISHED, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            expect(await agent.modules.installed()).toEqual({})
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    })

    it("records the module as a dependency, an activation, and a real package", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            const [result] = await agent.modules.install([published.name])
            expect(result?.status).toBe("installed")

            // presence — a semver range in package.json
            const declared = await agent.modules.installed()
            expect(declared[published.name]).toBeDefined()

            // activation — a string entry in axon.config.ts
            const config = await readFile(join(agent.root, "axon.config.ts"), "utf-8")
            expect(config).toContain(published.name)

            // materialization — Bun put a real package in node_modules
            expect(existsSync(join(agent.root, "node_modules", ...published.name.split("/")))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("a fresh Project() re-opened on the same root reads the same declarations from disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([published.name])

            const reopened = await platform.projects.open(agent.root)
            expect((await reopened.modules.installed())[published.name]).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)
})
