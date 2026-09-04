import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: typegen() env.d.ts", () => {
    it("a freshly scaffolded agent has no real keys — env count is 0, no env.d.ts written", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)

            expect(result.env).toBe(0)
            await expect(readFile(join(project.root, ".agent", "types", "env.d.ts"), "utf-8")).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("real keys in .env produce a typed ProcessEnv augmentation", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeFile(join(project.root, ".env"), "MY_API_KEY=secret\nANOTHER_KEY=value\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "env.d.ts"), "utf-8")

            expect(result.env).toBe(2)
            expect(dts).toContain("MY_API_KEY?: string")
            expect(dts).toContain("ANOTHER_KEY?: string")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("skips comments, blank lines, and malformed keys", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeFile(
                join(project.root, ".env"),
                "# a comment\n\nREAL_KEY=value\n123INVALID=nope\nno-equals-sign\n",
            )
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "env.d.ts"), "utf-8")

            expect(result.env).toBe(1)
            expect(dts).toContain("REAL_KEY?: string")
            expect(dts).not.toContain("123INVALID")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("never types the values themselves — only key names appear in the declaration", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeFile(join(project.root, ".env"), "SECRET_KEY=super-secret-value-12345\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "env.d.ts"), "utf-8")

            expect(dts).not.toContain("super-secret-value-12345")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
