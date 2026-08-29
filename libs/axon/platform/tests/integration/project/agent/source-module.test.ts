import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { Manifest } from "@arcforge/platform/build/project"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: loading a module directly from source", () => {
    /**
     * Declaration is axon.config.ts, always. A package sitting in
     * node_modules may be a transitive dependency of another module, and a
     * transitive dependency must never silently add tools to an agent's
     * surface — the tool surface belongs to a file the author reviews, not
     * to the filesystem.
     */
    it("ignores an installed package the config does not declare", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const packageName = `@test/${disposableName("undeclared")}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            const moduleRoot = join(agent.root, "node_modules", ...packageName.split("/"))
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.1.0" }))
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({})\n`)
            await writeFile(join(moduleRoot, "src", "tools", "undeclared.ts"), "export function undeclared(): string { return 'ok' }\n")

            const { blueprint } = await Blueprint({ root: agent.root }).load()

            expect(blueprint.modules?.some(module => module.name === packageName.split("/").pop())).toBe(false)
            expect(blueprint.tools?.some(tool => tool.name === "undeclared")).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("scans a registry module declared in axon.config.ts out of node_modules", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const packageName = `@test/${disposableName("declared")}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            const moduleRoot = join(agent.root, "node_modules", ...packageName.split("/"))
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.1.0" }))
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({})\n`)
            await writeFile(join(moduleRoot, "src", "tools", "declared.ts"), "export function declared(): string { return 'ok' }\n")

            await Manifest({ root: agent.root }).config.add(packageName)

            const { blueprint, warnings } = await Blueprint({ root: agent.root }).load()

            expect(warnings.filter(w => w.domain !== "cognet")).toEqual([])
            expect(blueprint.modules?.some(module => module.name === packageName.split("/").pop())).toBe(true)
            expect(blueprint.tools?.some(tool =>
                tool.name === "declared"
                && tool.modulePath === moduleRoot
                && tool.entryPath === join(moduleRoot, "src", "tools", "declared.ts")
            )).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("warns when a declared module is not installed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            await Manifest({ root: agent.root }).config.add("@test/never-installed")

            const { blueprint, warnings } = await Blueprint({ root: agent.root }).load()

            expect(warnings.some(w => w.domain === "modules" && w.error.includes("@test/never-installed"))).toBe(true)
            expect(blueprint.modules?.some(module => module.name === "never-installed")).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    /**
     * A registry module may also be reached by IMPORTING its config rather
     * than naming it as a string. Both forms must scan identically — the
     * import resolves through node_modules like any other package.
     */
    /**
     * SKIPPED — asserts behaviour the current architecture cannot provide.
     *
     * Config() evaluates axon.config.ts with a dynamic import(), which resolves
     * from the TUI platform's own location rather than the agent root, so a
     * package in <agent>/node_modules is unreachable. Real agents work only
     * because they sit inside the workspace whose root node_modules IS visible.
     * Un-skip when config evaluation moves into a subprocess rooted at the
     * agent — see debt.md.
     */
    it.skip("scans a registry module imported from node_modules", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const packageName = `@test/registry-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            const moduleRoot = join(agent.root, "node_modules", ...packageName.split("/"))
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.1.0" }))
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({})\n`)
            await writeFile(join(moduleRoot, "src", "tools", "lookup.ts"), "export function lookup(): string { return 'ok' }\n")

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "${packageName}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const { blueprint, warnings } = await Blueprint({ root: agent.root }).load()

            expect(warnings.filter(w => w.domain !== "cognet")).toEqual([])
            expect(blueprint.modules?.some(module => module.name === packageName.split("/").pop())).toBe(true)
            expect(blueprint.tools?.some(tool => tool.name === "lookup" && tool.modulePath === moduleRoot)).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("an imported module (no registry, no install step) is scanned into the blueprint", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName("agent")
        const moduleName = disposableName("srcmodule")

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })

            // A real, standalone module directory living next to the agent —
            // never installed, never published, imported directly by path.
            const moduleDir = moduleName.includes("/") ? moduleName.split("/").pop()! : moduleName
            const moduleRoot = join(dir, moduleDir)
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({})\n`)
            await writeFile(
                join(moduleRoot, "package.json"),
                JSON.stringify({ name: moduleName, version: "0.1.0", type: "module", private: true }, null, 2) + "\n",
            )
            await writeFile(
                join(moduleRoot, "src", "tools", "greet.ts"),
                "export function sourceGreet(): string { return 'hi from source module' }\n",
            )

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleDir}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const { blueprint, warnings } = await Blueprint({ root: agent.root }).load()

            // this test never runs prepare(), so the "no compiled cognet"
            // warning is expected — the subject here is module scanning,
            // which must produce no warnings of its own
            expect(warnings.filter(w => w.domain !== "cognet")).toEqual([])
            expect(blueprint.modules?.some(m => m.name === moduleDir)).toBe(true)
            // Each tool file inside a module keeps its own namespace (named
            // after the file, same convention as an agent's own
            // src/tools/*.ts) — a module is not collapsed into one
            // AxonTool named after itself. See scanModule().
            expect(blueprint.tools?.some(t => t.name === "greet" && t.modulePath === moduleRoot)).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a source module's tool becomes a typed global via typegen — no install/prepare step involved", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName("agent")
        const moduleName = disposableName("srcmodule")

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })

            const moduleRoot = join(dir, moduleName)
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({ name: "${moduleName}" })\n`)
            await writeFile(
                join(moduleRoot, "src", "tools", "greet.ts"),
                "export function sourceGreet(): string { return 'hi' }\n",
            )

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleName}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const { blueprint } = await Blueprint({ root: agent.root }).load()
            const result = await agent.typegen(blueprint)

            expect(result.toolGlobals).toBeGreaterThan(0)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("resolves a source module by its import path regardless of the config's export form", async () => {
        // A source module's identity is its import path, resolved statically
        // from axon.config.ts — NOT recovered from a defineModule() runtime
        // call. So a module.config.ts whose default export is a plain object
        // (no defineModule wrapper) still resolves and scans normally: the
        // file existing at the imported path is what matters.
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName("agent")
        const moduleDir = `srcmodule-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })

            const moduleRoot = join(dir, moduleDir)
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            // Plain-object export — no defineModule() wrapper. Identity comes
            // from the import path, so this still resolves and scans.
            await writeFile(join(moduleRoot, "module.config.ts"), `export default { }\n`)
            await writeFile(
                join(moduleRoot, "src", "tools", "plain.ts"),
                "export function plainTool(): string { return 'ok' }\n",
            )

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleDir}/module.config"\nexport default defineAgent({ modules: [Module] })\n`,
            )

            const { blueprint, warnings } = await Blueprint({ root: agent.root }).load()

            expect(warnings.some(w => w.error.includes("_sourcePath"))).toBe(false)
            expect(blueprint.modules?.some(m => m.name === moduleDir)).toBe(true)
            expect(blueprint.tools?.some(t => t.name === "plain")).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("fails config load loudly when a declared module's import resolves to nothing", async () => {
        // The failure mode the old stack-walk hid: a declared module that
        // resolves to nothing must surface loudly. Because Config() evaluates
        // axon.config.ts by importing it, an unresolvable module import throws
        // at config load — a broken config is no agent — rather than silently
        // contributing no tools.
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName("agent")

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Missing from "../does-not-exist/module.config"\nexport default defineAgent({ modules: [Missing] })\n`,
            )

            await expect(Blueprint({ root: agent.root }).load()).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
