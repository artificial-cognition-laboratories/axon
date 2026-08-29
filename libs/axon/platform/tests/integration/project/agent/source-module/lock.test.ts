import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

async function writeSourceModule(dir: string, name: string): Promise<string> {
    const root = join(dir, name)
    await mkdir(join(root, "src", "tools"), { recursive: true })
    await writeFile(join(root, "module.config.ts"), `export default defineModule({ name: "${name}" })\n`)
    await writeFile(join(root, "src", "tools", "greet.ts"), "export function greet(): string { return 'hi' }\n")
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name, version: "0.1.0", type: "module", private: true }, null, 2) + "\n",
    )
    return root
}

describe("agent project: source module content-hash lock", () => {
    it("re-preparing with no changes to the source module reports unchanged, not linked", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleName = disposableName("srcmodule")
            await writeSourceModule(dir, moduleName)

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleName}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const first = await agent.prepare()
            const second = await agent.prepare()

            expect(first.sourceModules[0]?.status).toBe("linked")
            expect(second.sourceModules[0]?.status).toBe("unchanged")
            expect(second.sourceModules[0]?.contentHash).toBe(first.sourceModules[0]?.contentHash)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("editing a source module's tool changes its content hash on the next prepare", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleName = disposableName("srcmodule")
            const moduleRoot = await writeSourceModule(dir, moduleName)

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleName}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const first = await agent.prepare()

            await writeFile(join(moduleRoot, "src", "tools", "greet.ts"), "export function greet(): string { return 'changed' }\n")
            const second = await agent.prepare()

            expect(second.sourceModules[0]?.status).toBe("linked")
            expect(second.sourceModules[0]?.contentHash).not.toBe(first.sourceModules[0]?.contentHash)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)
})
