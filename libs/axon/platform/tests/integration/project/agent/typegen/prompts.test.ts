import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: typegen() prompts.d.ts", () => {
    it("a freshly scaffolded agent has no prompts — count is 0, no prompts.d.ts written", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)

            expect(result.prompts).toBe(0)
            await expect(readFile(join(project.root, ".agent", "types", "prompts.d.ts"), "utf-8")).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a real static .md prompt becomes an AxonPromptMap entry with no props", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await mkdir(join(project.root, "src", "prompts"), { recursive: true })
            await writeFile(join(project.root, "src", "prompts", "greeting.md"), "# Say hello to the user\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "prompts.d.ts"), "utf-8")

            expect(result.prompts).toBe(1)
            expect(dts).toContain('"greeting": Record<string, never>')
            expect(dts).toContain("Say hello to the user")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a real dynamic .vue prompt's defineProps become typed prompt props", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await mkdir(join(project.root, "src", "prompts"), { recursive: true })
            await writeFile(
                join(project.root, "src", "prompts", "summary.vue"),
                "<template>Summarize {{ topic }}</template>\n<script setup lang=\"ts\">\nconst { topic } = defineProps<{ topic: string }>()\n</script>\n",
            )
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "prompts.d.ts"), "utf-8")

            expect(result.prompts).toBe(1)
            expect(dts).toContain('"summary"')
            expect(dts).toContain("topic")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("nested prompt directories are named with their relative path", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await mkdir(join(project.root, "src", "prompts", "support"), { recursive: true })
            await writeFile(join(project.root, "src", "prompts", "support", "refund.md"), "Handle a refund request\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "prompts.d.ts"), "utf-8")

            expect(result.prompts).toBe(1)
            expect(dts).toContain('"support/refund"')
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
