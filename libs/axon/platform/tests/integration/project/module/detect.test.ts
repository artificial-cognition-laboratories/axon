import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

describe("detecting a module project", () => {
    it("open() resolves kind 'module' for a scaffolded standalone module", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const created = await platform.projects.create("module", { name, dir })

            const opened = await platform.projects.open(created.root)
            expect(opened.kind).toBe("module")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("find() walks up from a nested subdirectory to the module root", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const created = await platform.projects.create("module", { name, dir })

            const nested = join(created.root, "src", "tools")
            await mkdir(nested, { recursive: true })

            expect(platform.projects.find(nested)).toBe(created.root)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("find() returns null above a tree with no module project", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-empty-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.projects.find(dir)).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("find() from inside a module nested under an agent resolves to the module root, not the agent root", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = `test-agent-${crypto.randomUUID().slice(0, 8)}`
        const moduleName = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })
            const module_ = await platform.projects.create("module", { name: moduleName, dir: agent.root })

            const nested = join(module_.root, "src", "tools")
            await mkdir(nested, { recursive: true })

            expect(platform.projects.find(nested)).toBe(module_.root)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
