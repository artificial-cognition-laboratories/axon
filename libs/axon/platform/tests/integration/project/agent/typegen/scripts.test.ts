import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Write a script into an agent, creating src/scripts/ if it is not there yet.
 *
 * A scaffolded agent is minimal: src/scripts/ exists only once the author
 * writes a script. That is what this stands in for, and it lives in one place
 * so every case states it the same way.
 */
async function writeScript(root: string, name: string, contents: string): Promise<void> {
    const dir = join(root, "src", "scripts")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), contents)
}

describe("agent project: typegen() scripts.d.ts", () => {
    it("a freshly scaffolded agent has no scripts — count is 0, no scripts.d.ts written", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)

            expect(result.scripts).toBe(0)
            await expect(readFile(join(project.root, ".agent", "types", "scripts.d.ts"), "utf-8")).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a script with no defineArgs() gets an empty args type", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeScript(project.root, "ping.ts", "console.log('pong')\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "scripts.d.ts"), "utf-8")

            expect(result.scripts).toBe(1)
            expect(dts).toContain('"ping": { args: Record<string, never>; return: unknown }')
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a real defineArgs<{...}>() call produces a typed args shape", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeScript(
                project.root,
                "greet.ts",
                "const { name } = defineArgs<{ name: string; loud?: boolean }>()\nconsole.log(name)\n",
            )
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "scripts.d.ts"), "utf-8")

            expect(result.scripts).toBe(1)
            expect(dts).toContain("name: string")
            expect(dts).toContain("loud?: boolean")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("carries the script's leading JSDoc as a description comment", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeScript(
                project.root,
                "greet.ts",
                "const { name } = defineArgs<{ name: string }>()\nconsole.log(name)\n",
            )
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "scripts.d.ts"), "utf-8")

            expect(result.scripts).toBe(1)
            expect(dts).toContain("Args: name: string")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("does not scan test files inside src/scripts/", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeScript(project.root, "ping.test.ts", "// should not be scanned\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)

            expect(result.scripts).toBe(0)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
