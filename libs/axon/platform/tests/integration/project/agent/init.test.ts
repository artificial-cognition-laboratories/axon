import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/** A scoped package name lives in a directory named by its unscoped segment. */
function unscoped(name: string): string {
    return name.includes("/") ? name.split("/").pop()! : name
}

describe("projects.create(\"agent\")", () => {
    it("scaffolds a new agent project and opens it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            expect(project.kind).toBe("agent")
            expect(project.name).toBe(name)
            expect(project.root).toBe(join(dir, unscoped(name)))
            expect(
                JSON.parse(await Bun.file(join(project.root, "package.json")).text()).private
            ).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("refuses to scaffold into an already-existing directory", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await platform.projects.create("agent", { name, dir })

            await expect(platform.projects.create("agent", { name, dir })).rejects.toThrow(
                /already exists/
            )
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("the scaffolded project is immediately discoverable via projects.find()", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            expect(platform.projects.find(project.root)).toBe(project.root)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("the scaffolded project is immediately re-openable via projects.open()", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const created = await platform.projects.create("agent", { name, dir })

            const reopened = await platform.projects.open(created.root)

            expect(reopened.kind).toBe("agent")
            expect(reopened.name).toBe(name)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("defaults dir to the current working directory when omitted", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-cwd-"))
        const name = disposableName()
        const originalCwd = process.cwd()

        try {
            process.chdir(dir)
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name })

            expect(project.root).toBe(join(dir, unscoped(name)))
        } finally {
            process.chdir(originalCwd)
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
