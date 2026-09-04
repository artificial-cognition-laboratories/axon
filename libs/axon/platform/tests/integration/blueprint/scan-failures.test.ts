import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * Every surface fails the way tools do.
 *
 * The tool scan was fixed first because that is where a user hit it, but the
 * same shape existed in five other scanners: a file the author wrote that fails
 * to import was warned about and skipped, and the warning was dropped at
 * runtime boot. The agent then ran without a route, a script, a plugin, a
 * middleware or a prompt that exists on disk, and nothing anywhere said so.
 *
 * Middleware is the one that makes the case on its own — it commonly carries
 * auth and validation, so silently skipping one is a request path running
 * without the checks its author wrote.
 *
 * What remains a warning is the genuinely graceful case: shadowing. Two things
 * claim one name, precedence resolves it, the scope stays coherent, and the
 * author is told which export they cannot reach.
 */

const dirs: string[] = []
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A real scaffolded agent with arbitrary files written into it. */
async function agentWith(files: Record<string, string>): Promise<string> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    dirs.push(storeDir, dir)

    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    const project = await platform.projects.create("agent", {
        name: `test-agent-${crypto.randomUUID().slice(0, 8)}`,
        dir,
    })

    for (const [relPath, source] of Object.entries(files)) {
        const abs = join(project.root, relPath)
        await mkdir(join(abs, ".."), { recursive: true })
        await writeFile(abs, source)
    }
    return project.root
}

/** An import that cannot resolve — the simplest way to make a file fail to load. */
const UNRESOLVABLE = "import { gone } from './nowhere'\nexport default gone\n"

describe("scan failures: a file that cannot load fails the load", () => {
    it("a route that cannot be imported", async () => {
        const root = await agentWith({ "server/api/broken.get.ts": UNRESOLVABLE })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 90_000)

    it("a plugin that cannot be imported", async () => {
        const root = await agentWith({ "server/plugins/broken.ts": UNRESOLVABLE })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 90_000)

    it("a middleware that cannot be imported", async () => {
        // The most consequential of these to lose quietly: middleware is where
        // auth and validation live.
        const root = await agentWith({ "server/middleware/broken.ts": UNRESOLVABLE })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 90_000)

    it("the failure names the offending file", async () => {
        const root = await agentWith({ "server/middleware/auth.ts": UNRESOLVABLE })

        expect(Blueprint({ root }).load()).rejects.toThrow(/auth/)
    }, 90_000)
})

describe("scan failures: a healthy agent still loads", () => {
    it("a well-formed route loads", async () => {
        const root = await agentWith({
            "server/api/hello.get.ts": "export default () => ({ ok: true })\n",
        })

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.server?.routes?.some(r => r.path.includes("hello"))).toBe(true)
    }, 90_000)

    it("an agent with none of these surfaces loads cleanly", async () => {
        const root = await agentWith({})

        const { warnings } = await Blueprint({ root }).load()

        expect(warnings).toEqual([])
    }, 90_000)
})

describe("scan warnings: shadowing stays a warning", () => {
    it("a module tool shadowed by the agent's own is reported, not fatal", async () => {
        // The one case that genuinely degrades gracefully: the scope is
        // coherent, the agent's tool wins, and the author is told which module
        // export they cannot reach.
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        dirs.push(storeDir, dir)

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const project = await platform.projects.create("agent", {
            name: `test-agent-${crypto.randomUUID().slice(0, 8)}`,
            dir,
        })

        const moduleRoot = join(project.root, "modules", "weather")
        await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
        await writeFile(join(moduleRoot, "module.config.ts"), "export default defineModule({})\n")
        await writeFile(
            join(moduleRoot, "src", "tools", "weather.ts"),
            "export const weather = { now: async (): Promise<string> => 'module' }\n",
        )
        await mkdir(join(project.root, "src", "tools"), { recursive: true })
        await writeFile(
            join(project.root, "src", "tools", "weather.ts"),
            "export const weather = { now: async (): Promise<string> => 'agent' }\n",
        )
        await writeFile(
            join(project.root, "axon.config.ts"),
            `export default defineAgent({ providers: [Mock()], model: "mock:mock", modules: ["./modules/weather"] })\n`,
        )

        const { blueprint, warnings } = await Blueprint({ root: project.root }).load()

        expect(blueprint.tools?.filter(t => t.name === "weather")).toHaveLength(1)
        expect(warnings.some(w => w.domain === "tools" && w.error.includes("weather"))).toBe(true)
    }, 90_000)
})
