import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: typegen() tsconfig", () => {
    it("writes a real .agent/types/tsconfig.json that extends the published base", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const tsconfig = JSON.parse(await readFile(join(project.root, ".agent", "types", "tsconfig.json"), "utf-8"))

            // Compiler flags are NOT written here — they come from
            // @arcforge/types/tsconfig.base.json, resolved through the agent's
            // own node_modules. prepare writes codegen and a thin extends
            // pointer, never machine-local compiler configuration.
            expect(tsconfig.extends).toBe("@arcforge/types/tsconfig.base.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes a thin root tsconfig.json pointing at .agent/types/tsconfig.json", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const root = JSON.parse(await readFile(join(project.root, "tsconfig.json"), "utf-8"))

            expect(root.extends).toBe("./.agent/types/tsconfig.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("upgrades a root tsconfig.json that still has its own includes back to the thin pointer", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const rootPath = join(project.root, "tsconfig.json")
            await Bun.write(rootPath, JSON.stringify({ include: ["**/*.ts"] }))

            await project.typegen(blueprint)
            const root = JSON.parse(await readFile(rootPath, "utf-8"))

            expect(root.extends).toBe("./.agent/types/tsconfig.json")
            expect(root.include).toBeUndefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
