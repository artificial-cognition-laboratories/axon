import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

/** A scoped package name lives in a directory named by its unscoped segment. */
function unscoped(name: string): string {
    return name.includes("/") ? name.split("/").pop()! : name
}

describe("projects.create(\"module\")", () => {
    it("scaffolds a new standalone module project and opens it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            expect(project.kind).toBe("module")
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
            await platform.projects.create("module", { name, dir })

            await expect(platform.projects.create("module", { name, dir })).rejects.toThrow(
                /already exists/
            )
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("the scaffolded module is immediately re-openable via projects.open()", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const created = await platform.projects.create("module", { name, dir })

            const reopened = await platform.projects.open(created.root)

            expect(reopened.kind).toBe("module")
            expect(reopened.name).toBe(name)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("nests under modules/<name> when scaffolded inside an existing agent project", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = `test-agent-${crypto.randomUUID().slice(0, 8)}`
        const moduleName = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })

            const module_ = await platform.projects.create("module", {
                name: moduleName,
                dir: agent.root,
            })

            expect(module_.root).toBe(join(agent.root, "modules", unscoped(moduleName)))
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
            const project = await platform.projects.create("module", { name })

            expect(project.root).toBe(join(dir, unscoped(name)))
        } finally {
            process.chdir(originalCwd)
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
