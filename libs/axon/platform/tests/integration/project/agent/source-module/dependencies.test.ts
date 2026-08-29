import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

/**
 * A source module's own npm dependencies.
 *
 * These used to be merged into the agent's package.json by hand, with a
 * reconciler that threw when two modules declared incompatible ranges. A
 * source module is now a `file:` dependency, so Bun installs its
 * dependencies exactly as it does for a published package — including
 * nesting two incompatible versions rather than failing. That conflict was
 * never a real incompatibility; it was an artifact of flattening every
 * module's dependencies into one manifest.
 *
 * What must still hold: prepare() links the module, hashes its content, and
 * leaves every dependency genuinely present on disk.
 */

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

/** A scoped package name lives in a directory named by its unscoped segment. */
function unscoped(name: string): string {
    return name.includes("/") ? name.split("/").pop()! : name
}

/** Scaffold a standalone source module (never installed/published) with an optional package.json dependency. */
async function writeSourceModule(dir: string, name: string, opts?: { dependency?: [string, string] }): Promise<string> {
    const root = join(dir, unscoped(name))
    await mkdir(join(root, "src", "tools"), { recursive: true })
    await writeFile(join(root, "module.config.ts"), `export default defineModule({})\n`)
    await writeFile(join(root, "src", "tools", "greet.ts"), "export function greet(): string { return 'hi' }\n")
    await writeFile(
        join(root, "package.json"),
        JSON.stringify(
            {
                name,
                version: "0.1.0",
                type: "module",
                private: true,
                ...(opts?.dependency ? { dependencies: { [opts.dependency[0]]: opts.dependency[1] } } : {}),
            },
            null,
            2,
        ) + "\n",
    )
    return root
}

describe("agent project: source module dependencies", () => {
    it("prepare() declares the module as a file: dependency and installs what it needs", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleName = disposableName("srcmodule")
            await writeSourceModule(dir, moduleName, { dependency: ["is-odd", "^3.0.1"] })

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${unscoped(moduleName)}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const result = await agent.prepare()

            expect(result.sourceModules).toHaveLength(1)
            expect(result.sourceModules[0]).toMatchObject({ status: "linked", name: unscoped(moduleName) })
            expect(result.sourceModules[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)

            // The agent points at the module on disk; the module's own
            // dependency is Bun's to resolve, never spliced into the
            // agent's manifest.
            const agentPkg = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(agentPkg.dependencies[moduleName]).toMatch(/^file:/)
            expect(agentPkg.dependencies["is-odd"]).toBeUndefined()

            expect(existsSync(join(agent.root, "node_modules", "is-odd"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    /**
     * The old merge threw MODULE_DEPENDENCY_CONFLICT here. Nesting is the
     * correct outcome — two packages wanting different majors of the same
     * dependency is ordinary, and npm solved it in 2016.
     */
    it("two source modules with incompatible dependency ranges both prepare", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleA = disposableName("srcmodule-a")
            const moduleB = disposableName("srcmodule-b")
            await writeSourceModule(dir, moduleA, { dependency: ["is-odd", "^1.0.0"] })
            await writeSourceModule(dir, moduleB, { dependency: ["is-odd", "^3.0.1"] })

            await writeFile(
                join(agent.root, "axon.config.ts"),
                [
                    `import ModuleA from "../${unscoped(moduleA)}/module.config"`,
                    `import ModuleB from "../${unscoped(moduleB)}/module.config"`,
                    `export default defineAgent({ modules: [ModuleA, ModuleB] })`,
                    "",
                ].join("\n"),
            )

            const result = await agent.prepare()

            expect(result.sourceModules).toHaveLength(2)
            expect(result.sourceModules.every(m => m.status === "linked")).toBe(true)
            expect(existsSync(join(agent.root, "node_modules", "is-odd"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("two source modules with overlapping dependency ranges both prepare cleanly", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleA = disposableName("srcmodule-a")
            const moduleB = disposableName("srcmodule-b")
            await writeSourceModule(dir, moduleA, { dependency: ["is-odd", "^3.0.0"] })
            await writeSourceModule(dir, moduleB, { dependency: ["is-odd", "^3.0.1"] })

            await writeFile(
                join(agent.root, "axon.config.ts"),
                [
                    `import ModuleA from "../${unscoped(moduleA)}/module.config"`,
                    `import ModuleB from "../${unscoped(moduleB)}/module.config"`,
                    `export default defineAgent({ modules: [ModuleA, ModuleB] })`,
                    "",
                ].join("\n"),
            )

            const result = await agent.prepare()

            expect(result.sourceModules).toHaveLength(2)
            expect(result.sourceModules.every(m => m.status === "linked")).toBe(true)

            const agentPkg = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(agentPkg.dependencies[moduleA]).toMatch(/^file:/)
            expect(agentPkg.dependencies[moduleB]).toMatch(/^file:/)
            expect(existsSync(join(agent.root, "node_modules", "is-odd"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)
})

describe("agent project: source module pruning", () => {
    /**
     * Moving a module from a local import to a registry install left its
     * `file:` dependency behind, so Bun kept linking the local directory and
     * the registry version could never take its place. The config is the
     * declaration — a `file:` dep nothing declares is dead.
     */
    it("removes a file: dependency once its source import leaves the config", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            const moduleName = disposableName("srcmodule")
            await writeSourceModule(dir, moduleName)

            // Declared as a source import: prepare() records the file: dep.
            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${unscoped(moduleName)}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )
            await agent.prepare()

            const linked = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(linked.dependencies[moduleName]).toMatch(/^file:/)

            // Import removed — the dependency must go with it.
            await writeFile(join(agent.root, "axon.config.ts"), `export default defineAgent({ modules: [] })\n`)
            await agent.prepare()

            const pruned = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            expect(pruned.dependencies[moduleName]).toBeUndefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("leaves the agent's own npm dependencies alone", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            const before = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            const ownDeps = Object.keys(before.dependencies ?? {})

            await writeFile(join(agent.root, "axon.config.ts"), `export default defineAgent({ modules: [] })\n`)
            await agent.prepare()

            const after = JSON.parse(await readFile(join(agent.root, "package.json"), "utf-8"))
            for (const dep of ownDeps) expect(after.dependencies[dep]).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)
})
