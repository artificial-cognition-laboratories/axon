import { mkdtemp, rm, readFile } from "node:fs/promises"
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

describe("installer: version upgrades", () => {
    it("installing an explicit version constraint that differs from the lock re-installs", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })

            const v1 = await module_.publish()
            expect(v1.version).toBe("0.1.0")

            const pkgPath = join(module_.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
            pkg.version = "0.2.0"
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))
            const v2 = await module_.publish()
            expect(v2.version).toBe("0.2.0")

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            const first = await agent.modules.install([`${v1.name}@0.1.0`])
            expect(first[0]).toEqual({ status: "installed", name: v1.name, version: "0.1.0" })

            const second = await agent.modules.install([`${v1.name}@0.2.0`])
            expect(second[0]).toEqual({ status: "installed", name: v1.name, version: "0.2.0" })

            const manifest = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(manifest.dependencies[v1.name]).toBe("0.2.0")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("installing with no constraint after a version-pinned install leaves the locked version alone (no implicit upgrade)", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const moduleDir = await mkdtemp(join(tmpdir(), "axon-test-module-dir-"))
        const agentDir = await mkdtemp(join(tmpdir(), "axon-test-agent-dir-"))

        try {
            const platform = await authenticatedPlatform(storeDir)
            const module_ = await platform.projects.create("module", { name: disposableName("module"), dir: moduleDir })

            const v1 = await module_.publish()

            const pkgPath = join(module_.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
            pkg.version = "0.2.0"
            await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))
            await module_.publish()

            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir: agentDir })

            await agent.modules.install([`${v1.name}@0.1.0`])
            const result = await agent.modules.install([v1.name])

            // A bare (unversioned) specifier is satisfied by whatever's already
            // locked — install() never silently upgrades without an explicit
            // version bump, same as a package manager's lockfile discipline.
            expect(result[0]).toEqual({ status: "already-installed", name: v1.name, version: "0.1.0" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(moduleDir, { recursive: true, force: true })
            await rm(agentDir, { recursive: true, force: true })
        }
    }, 30_000)
})
