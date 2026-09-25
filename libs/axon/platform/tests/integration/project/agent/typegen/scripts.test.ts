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

    it("discovers namespaced workspace scripts from the invocation workspace", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-workspace-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const scripts = join(dir, ".agents", "scripts")
            await mkdir(scripts, { recursive: true })
            await writeFile(
                join(scripts, "deploy.ts"),
                "/** Deploy the current workspace. */\nconst { target } = defineArgs<{ target: string }>()\nconsole.log(target)\n",
            )

            const { blueprint } = await Blueprint({ root: project.root, cwd: dir }).load()

            expect(blueprint.scripts).toContainEqual(expect.objectContaining({
                name: "workspace:deploy",
                description: "Deploy the current workspace.",
                args: [{ name: "target", type: "string", required: true }],
            }))

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "scripts.d.ts"), "utf-8")
            expect(result.scripts).toBe(1)
            expect(dts).toContain('"workspace:deploy": { args: { target: string }; return: unknown }')
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("honors workspace: false for workspace scripts", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-workspace-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ workspace: false })\n")
            const scripts = join(dir, ".agents", "scripts")
            await mkdir(scripts, { recursive: true })
            await writeFile(join(scripts, "deploy.ts"), "console.log('deploy')\n")

            const { blueprint } = await Blueprint({ root: project.root, cwd: dir }).load()

            expect(blueprint.scripts?.some(script => script.name === "workspace:deploy")).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })


    it("warns and skips an unreadable workspace script without losing its peers", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-workspace-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const scripts = join(dir, ".agents", "scripts")
            await mkdir(scripts, { recursive: true })
            await writeFile(join(scripts, "good.ts"), "console.log('good')\n")
            await mkdir(join(scripts, "bad.ts"))

            const { blueprint, warnings } = await Blueprint({ root: project.root, cwd: dir }).load()

            expect(blueprint.scripts?.map(script => script.name)).toContain("workspace:good")
            expect(blueprint.scripts?.map(script => script.name)).not.toContain("workspace:bad")
            expect(warnings.some(warning => warning.domain === "scripts" && warning.error.includes("bad.ts"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("types workspace prompt names and props in the workspace script frame", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-workspace-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await mkdir(join(dir, ".agents", "scripts"), { recursive: true })
            await mkdir(join(dir, ".agents", "prompts"), { recursive: true })
            await writeFile(join(dir, ".agents", "scripts", "run.ts"), "await axon.prompt('workspace:hello')\\n")
            await writeFile(
                join(dir, ".agents", "prompts", "hello.vue"),
                "<template>Hello</template>\\n<script setup lang=\"ts\">\\nconst { name } = defineProps<{ name: string }>()\\n</script>\\n",
            )

            const { blueprint } = await Blueprint({ root: project.root, cwd: dir }).load()
            const { Typegen } = await import("../../../../../src/build/project/typegen")
            await Typegen({ root: project.root, kind: "agent", cwd: dir }).write(blueprint)

            const globals = await readFile(join(dir, ".agents", ".axon", "globals.d.ts"), "utf-8")
            expect(globals).toContain('interface WorkspacePromptMap { "workspace:hello": { name: string } }')
            expect(globals).toContain("WorkspacePromptName")
            expect(globals).toContain("workspace:")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes a disposable workspace type frame for the selected agent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-workspace-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const scripts = join(dir, ".agents", "scripts")
            await mkdir(scripts, { recursive: true })
            await writeFile(join(scripts, "deploy.ts"), "console.log('deploy')\n")

            const { blueprint } = await Blueprint({ root: project.root, cwd: dir }).load()
            const { Typegen } = await import("../../../../../src/build/project/typegen")
            await Typegen({ root: project.root, kind: "agent", cwd: dir }).write(blueprint)

            const globals = await readFile(join(dir, ".agents", ".axon", "globals.d.ts"), "utf-8")
            const config = JSON.parse(await readFile(join(dir, ".agents", "tsconfig.json"), "utf-8"))

            expect(globals).toContain("const axon")
            expect(globals).toContain("function defineArgs")
            expect(config.include).toEqual(["scripts/**/*.ts", ".axon/**/*.d.ts"])
            expect(config.compilerOptions).toMatchObject({
                target: "ESNext",
                module: "ESNext",
                moduleDetection: "force",
                types: ["bun-types"],
            })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

})
