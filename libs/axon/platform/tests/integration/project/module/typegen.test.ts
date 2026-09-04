import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

describe("module project: typegen()", () => {
    it("writes only the static frame — zero counts for surface-driven generators", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const result = await project.typegen()

            expect(result).toEqual({ toolGlobals: 0, prompts: 0, scripts: 0, components: 0, env: 0 })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes a real .module/types/axon.d.ts declaring the runtime globals", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await project.typegen()
            const dts = await readFile(join(project.root, ".module", "types", "axon.d.ts"), "utf-8")

            expect(dts).toContain("const axon: AxonHandle")
            expect(dts).toContain("do not edit")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes a real .module/types/tsconfig.json and a thin root pointer", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await project.typegen()

            const moduleTsconfig = JSON.parse(await readFile(join(project.root, ".module", "types", "tsconfig.json"), "utf-8"))
            const rootTsconfig = JSON.parse(await readFile(join(project.root, "tsconfig.json"), "utf-8"))

            // Strictness comes from the PUBLISHED base, not from anything
            // written here — .module/types/tsconfig.json extends
            // @arcforge/types/tsconfig.base.json, resolved through the
            // project's own node_modules. Asserting an inlined
            // compilerOptions.strict pinned an older design where prepare
            // wrote compiler flags itself.
            expect(moduleTsconfig.extends).toBe("@arcforge/types/tsconfig.base.json")
            expect(rootTsconfig.extends).toBe("./.module/types/tsconfig.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("does not require a blueprint argument — module typegen is the static frame only", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await expect(project.typegen()).resolves.toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
