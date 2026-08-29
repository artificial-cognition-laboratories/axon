import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

/**
 * What reaches the deploy tarball.
 *
 * Two module origins, packaged differently on purpose:
 *
 *   registry modules — ordinary packages, DECLARED not shipped. package.json
 *     and bun.lock state them; `bun install` materializes them at prepare time
 *     (local) or image build time (deploy). The tarball carries no
 *     node_modules at all.
 *   source modules — live OUTSIDE the agent root, so no install can resolve
 *     them. They are staged into modules/<name>/ and the config's relative
 *     imports rebased to match.
 *
 * A scoped package name maps to a directory named by its unscoped segment,
 * the same way npm names a folder "thing" for "@me/thing".
 */

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

/** A scoped package name lives in a directory named by its unscoped segment. */
function unscoped(name: string): string {
    return name.includes("/") ? name.split("/").pop()! : name
}

async function writeSourceModule(dir: string, name: string): Promise<string> {
    const root = join(dir, unscoped(name))
    await mkdir(join(root, "src", "tools"), { recursive: true })
    await writeFile(join(root, "module.config.ts"), `export default defineModule({})\n`)
    await writeFile(
        join(root, "src", "tools", "greet.ts"),
        "export function greet(): string { return 'hi' }\n"
    )
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name, version: "0.1.0", type: "module", private: true }, null, 2) + "\n"
    )
    return root
}

describe("agent project: bundling modules into the deploy tarball", () => {
    it("declares a registry module in the manifest rather than shipping its files", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const packageName = `@test/registry-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            // Stand in for what the package manager would have installed.
            const moduleRoot = join(agent.root, "node_modules", ...packageName.split("/"))
            await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
            await writeFile(join(moduleRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.1.0" }))
            await writeFile(join(moduleRoot, "module.config.ts"), `export default defineModule({})\n`)
            await writeFile(join(moduleRoot, "src", "tools", "lookup.ts"), "export function lookup(): string { return 'ok' }\n")

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `export default defineAgent({ modules: ["${packageName}"] })\n`,
            )

            const { tarball } = await agent.bundle()
            const list = await Bun.$`tar -tzf ${tarball}`.text()

            // A registry module is resolvable by name, so shipping its bytes is
            // redundant at best. At worst it is fatal: an agent with native
            // dependencies (onnxruntime, kokoro) carries every platform's
            // prebuilds and blows the registry size limit, and the tree that
            // ships is whatever the PUBLISHER's machine happened to resolve.
            expect(list).not.toContain("node_modules/")

            // What replaces it: the declaration. package.json states the
            // dependency and bun.lock pins what it resolves to, which is the
            // whole input `bun install` needs on the other side.
            expect(list).toContain("package.json")
            expect(list).toContain("axon.config.ts")

            const extracted = await mkdtemp(join(tmpdir(), "axon-test-extracted-"))
            try {
                await Bun.$`tar -xzf ${tarball} -C ${extracted}`
                const config = await Bun.file(join(extracted, "axon.config.ts")).text()
                expect(config).toContain(packageName)
            } finally {
                await rm(extracted, { recursive: true, force: true })
            }
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("packages the source module's files into modules/<name>/ in the deploy tarball", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", {
                name: disposableName("agent"),
                dir,
            })
            const moduleName = disposableName("srcmodule")
            const moduleDir = unscoped(moduleName)
            await writeSourceModule(dir, moduleName)

            await writeFile(
                join(agent.root, "axon.config.ts"),
                `import Module from "../${moduleDir}/module.config"\nexport default defineAgent({ modules: [Module] })\n`
            )

            await agent.prepare()
            const { tarball } = await agent.bundle()

            const list = await Bun.$`tar -tzf ${tarball}`.text()
            expect(list).toContain(`modules/${moduleDir}/module.config.ts`)
            expect(list).toContain(`modules/${moduleDir}/src/tools/greet.ts`)

            const extracted = await mkdtemp(join(tmpdir(), "axon-test-extracted-"))
            try {
                await Bun.$`tar -xzf ${tarball} -C ${extracted}`
                const bundledConfig = await Bun.file(join(extracted, "axon.config.ts")).text()
                expect(bundledConfig).toContain(`./modules/${moduleDir}/module.config.ts`)

                const { Blueprint } = await import("@arcforge/platform/build/blueprint")
                const { blueprint } = await Blueprint({ root: extracted }).load()
                expect(blueprint.modules?.some(module => module.name === moduleDir)).toBe(true)
            } finally {
                await rm(extracted, { recursive: true, force: true })
            }

            // Staging is transient — the agent's own working tree never gets the copy.
            expect(existsSync(join(agent.root, "modules", moduleDir))).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)
})
