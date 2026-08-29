import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: typegen() components.d.ts", () => {
    it("a freshly scaffolded agent has no components — count is 0, no components.d.ts written", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)

            expect(result.components).toBe(0)
            await expect(readFile(join(project.root, ".agent", "types", "components.d.ts"), "utf-8")).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a real .vue component in src/prompts/components/ becomes a typed global component", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            await mkdir(join(project.root, "src", "prompts", "components"), { recursive: true })
            await writeFile(join(project.root, "src", "prompts", "components", "scouting-basics.vue"), "<template>Basics</template>\n")
            const { blueprint } = await Blueprint({ root: project.root }).load()

            const result = await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "components.d.ts"), "utf-8")

            expect(result.components).toBe(1)
            expect(dts).toContain("ScoutingBasics:")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a component from an installed module is included", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName()
        const moduleName = `test-module-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })
            const module_ = await platform.projects.create("module", { name: moduleName, dir: agent.root })

            await mkdir(join(module_.root, "src", "prompts", "components"), { recursive: true })
            await writeFile(join(module_.root, "src", "prompts", "components", "module-widget.vue"), "<template>Widget</template>\n")

            const { blueprint } = await Blueprint({ root: agent.root }).load()
            const result = await agent.typegen(blueprint)
            const dts = await readFile(join(agent.root, ".agent", "types", "components.d.ts"), "utf-8")

            expect(result.components).toBe(1)
            expect(dts).toContain("ModuleWidget:")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("an agent component wins over a module component with the same name", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName()
        const moduleName = `test-module-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })
            const module_ = await platform.projects.create("module", { name: moduleName, dir: agent.root })

            await mkdir(join(module_.root, "src", "prompts", "components"), { recursive: true })
            await writeFile(join(module_.root, "src", "prompts", "components", "widget.vue"), "<template>Module version</template>\n")

            await mkdir(join(agent.root, "src", "prompts", "components"), { recursive: true })
            await writeFile(join(agent.root, "src", "prompts", "components", "widget.vue"), "<template>Agent version</template>\n")

            const { blueprint } = await Blueprint({ root: agent.root }).load()
            const result = await agent.typegen(blueprint)
            const dts = await readFile(join(agent.root, ".agent", "types", "components.d.ts"), "utf-8")

            expect(result.components).toBe(1)
            expect(dts).toContain(`typeof import("../src/prompts/components/widget.vue")`)
            expect(dts).not.toContain("modules/")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
