import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../setup/user"

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
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

describe("agent project: prepare()", () => {
    it("installs a real declared registry module and its surfaces are typed after prepare", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)

            // Publish a real module to staging so there's something real to install.
            const moduleName = disposableName("module")
            const module_ = await platform.projects.create("module", { name: moduleName, dir: moduleDir })
            await writeFile(
                join(module_.root, "src", "tools", "greet.ts"),
                "export function greet(name: string): string { return `hello ${name}` }\n",
            )
            const published = await module_.publish()

            // Declare it in a fresh agent's config, then prepare().
            const agentName = disposableName("agent")
            const agent = await platform.projects.create("agent", { name: agentName, dir: agentDir })
            await writeFile(
                join(agent.root, "axon.config.ts"),
                `export default defineAgent({ modules: ["${published.name}"] })\n`,
            )

            const result = await agent.prepare()

            expect(result.modules).toHaveLength(1)
            expect(result.modules[0]?.status).toBe("installed")
            expect(result.warnings).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("re-preparing with the module already installed at the same version is a no-op install", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)

            const moduleName = disposableName("module")
            const module_ = await platform.projects.create("module", { name: moduleName, dir: moduleDir })
            const published = await module_.publish()

            const agentName = disposableName("agent")
            const agent = await platform.projects.create("agent", { name: agentName, dir: agentDir })
            await writeFile(
                join(agent.root, "axon.config.ts"),
                `export default defineAgent({ modules: ["${published.name}"] })\n`,
            )

            await agent.prepare()
            const second = await agent.prepare()

            expect(second.modules[0]?.status).toBe("already-installed")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("an agent declaring no modules prepares cleanly with an empty install list", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const result = await agent.prepare()

            expect(result.modules).toEqual([])
            expect(result.warnings).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 15_000)
})
