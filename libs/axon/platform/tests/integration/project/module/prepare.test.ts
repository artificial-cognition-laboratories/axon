import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

describe("module project: prepare()", () => {
    it("returns no module installs and the static typegen frame", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const result = await project.prepare()

            expect(result.modules).toEqual([])
            expect(result.warnings).toEqual([])
            expect(result.typegen).toEqual({ toolGlobals: 0, prompts: 0, scripts: 0, components: 0, env: 0 })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("actually writes the static frame to disk — axon.d.ts and tsconfig.json", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await project.prepare()

            const dts = await readFile(join(project.root, ".module", "types", "axon.d.ts"), "utf-8")
            const tsconfig = JSON.parse(await readFile(join(project.root, ".module", "types", "tsconfig.json"), "utf-8"))

            expect(dts).toContain("const axon: AxonHandle")
            // Compiler flags come from the published base this extends, not
            // from anything prepare writes — see typegen/tsconfig.ts.
            expect(tsconfig.extends).toBe("@arcforge/types/tsconfig.base.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
