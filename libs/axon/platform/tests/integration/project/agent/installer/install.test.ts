import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK_PUBLISHED } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

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

describe("installer: install()", () => {
    it("installs a real published module and returns status 'installed'", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            const results = await agent.modules.install([published.name])

            expect(results).toHaveLength(1)
            expect(results[0]).toEqual({ status: "installed", name: published.name, version: "0.1.0" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    /**
     * bun.lock is the lockfile now. It must pin the module with a STABLE
     * tarball URL and an SRI integrity digest — the previous hand-rolled
     * lockfile recorded a 15-minute signed GCS URL (a bearer credential,
     * committed to the repo, dead almost immediately) and a bare sha256 it
     * never actually verified.
     */
    it("pins the module in bun.lock with a stable URL and a verifiable digest", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([published.name])

            const lock = await readFile(join(agent.root, "bun.lock"), "utf-8")

            expect(lock).toContain(`${published.name}@0.1.0`)
            expect(lock).toContain("sha512-")
            // No credential may reach the lockfile.
            expect(lock).not.toContain("X-Goog-Signature")
            expect(lock).not.toContain("X-Goog-Expires")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 60_000)

    it("exposes the real module source as a package in node_modules/", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })
            await Bun.write(join(module_.root, "src", "tools", "greet.ts"), "export function greet(): string { return 'hi' }\n")
            const published = await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })
            await agent.modules.install([published.name])

            const installedFile = await readFile(
                join(agent.root, "node_modules", ...published.name.split("/"), "src", "tools", "greet.ts"),
                "utf-8",
            )
            const configFile = await readFile(join(agent.root, "node_modules", ...published.name.split("/"), "module.config.ts"), "utf-8")

            expect(installedFile).toContain("export function greet")
            expect(configFile).toContain("defineModule")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("returns an empty array for an empty specifier list, without writing a lock file", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const results = await agent.modules.install([])

            expect(results).toEqual([])
            await expect(readFile(join(agent.root, ".agent", "cache", "modules.lock.json"), "utf-8")).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    })
})
