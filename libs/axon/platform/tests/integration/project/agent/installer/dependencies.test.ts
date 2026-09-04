import { mkdtemp, rm, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * A module's own npm dependencies.
 *
 * These used to be spliced into the AGENT's package.json by a hand-rolled
 * merge that threw on conflicting ranges. Now a module is an ordinary
 * package, so its dependencies are Bun's business: it installs them,
 * nests them when two modules disagree, and leaves the agent's declared
 * dependencies alone. What still has to hold — and is what these assert —
 * is that installing a module leaves the agent immediately bootable, with
 * every transitive dependency actually present on disk.
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

describe("installer: module dependencies", () => {
    it("materializes a module's own dependency without adding it to the agent's manifest", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })

            const pkgPath = join(module_.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
            pkg.dependencies = { "is-odd": "^3.0.1" }
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))

            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            const results = await agent.modules.install([published.name])
            expect(results[0]?.status).toBe("installed")

            // The agent declares the MODULE, never the module's own deps.
            const agentPkg = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(agentPkg.dependencies[published.name]).toBeDefined()
            expect(agentPkg.dependencies["is-odd"]).toBeUndefined()

            // But the dependency is still really there — an install must
            // leave the agent bootable, not waiting on a later prepare().
            expect(existsSync(join(agent.root, "node_modules", "is-odd"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("adds only the module itself when it has no dependencies of its own", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            const before = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))

            await agent.modules.install([published.name])

            const after = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(Object.keys(after.dependencies ?? {}))
                .toEqual([...Object.keys(before.dependencies ?? {}), published.name])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)
})
