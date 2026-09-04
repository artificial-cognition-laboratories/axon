import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Tools } from "@arcforge/platform/build/blueprint/scan/tools"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * What becomes a tool.
 *
 * Exactly one thing does: a file in src/tools/ exporting functions. The
 * capsule is a separate OS process, so a tool must be something it can load
 * and call — which npm dependencies are not. They are available to the
 * agent project's SOURCE (the author may import them), and that is a
 * different boundary entirely.
 *
 * Dependencies used to be scanned, introspected, and given entries here.
 * The capsule dropped them all (no loadable entry), but the editor's
 * ambient declarations still rendered them, so an agent was told it could
 * call @vue/compiler-sfc internals that existed nowhere in its runtime.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

async function declareDependency(agentRoot: string, depName: string): Promise<void> {
    const pkgPath = join(agentRoot, "package.json")
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
    pkg.dependencies = { ...pkg.dependencies, [depName]: "1.0.0" }
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
}

async function writeTool(agentRoot: string, file: string, source: string): Promise<void> {
    const dir = join(agentRoot, "src", "tools")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), source)
}

describe("Tools(): what becomes a tool", () => {
    it("a src/tools file's exports become a flat tool with a real entry path", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            await writeTool(project.root, "greet.ts", "export function greet(name: string): string { return `hi ${name}` }\n")

            const result = await Tools(project.root)

            const entry = result.entries.find(e => e.name === "greet")
            // `origin` IS the placement decision — "src" means flat. There is
            // no separate `flat` field; it was removed when origin became the
            // single source of that answer.
            expect(entry?.origin).toBe("src")
            expect(entry?.entryPath).toBe(join(project.root, "src", "tools", "greet.ts"))
            expect(entry?.fns.map(f => f.name)).toEqual(["greet"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("a package dependency with a full .d.ts contributes nothing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            await declareDependency(project.root, "fake-pkg")

            const pkgDir = join(project.root, "node_modules", "fake-pkg")
            await mkdir(pkgDir, { recursive: true })
            await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-pkg", types: "index.d.ts" }))
            await writeFile(join(pkgDir, "index.d.ts"), "export function shouldNotBeATool(): void\n")

            const result = await Tools(project.root)

            expect(result.entries).toEqual([])
            expect(result.warnings).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("re-exporting a dependency from src/tools is how it becomes callable", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            await writeTool(project.root, "shout.ts", "export function shout(text: string): string { return text.toUpperCase() }\n")

            const result = await Tools(project.root)

            expect(result.entries.map(e => e.name)).toEqual(["shout"])
            expect(result.entries[0]?.entryPath).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("no src/tools directory — no tools at all", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            await declareDependency(project.root, "some-dep")

            const result = await Tools(project.root)

            expect(result.entries).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)
})
