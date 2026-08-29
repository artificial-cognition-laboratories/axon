import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { ask } from "../../setup/agent"

/**
 * Modules changing under a running agent.
 *
 * A source module is developed in place — the author edits it while the agent
 * that declares it is live. Adding, editing and removing one all ride the same
 * watcher→rescan→update path an agent's own tool edit rides, so the properties
 * are the same: the scope tracks the source, a failure never takes the running
 * agent with it, and fixing the source is enough to recover.
 *
 * These use the real agent runtime rather than Blueprint.load() directly,
 * because the interesting failures are transitions between states rather than
 * any single scan.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

const objectTool = (name: string, value: string) => `export const ${name} = { now: async (): Promise<string> => '${value}' }\n`
const BROKEN = "import { gone } from './nowhere'\nexport const weather = { now: () => gone }\n"

async function mockAgent(platform: ReturnType<typeof Platform>, dir: string) {
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    const moduleRoot = join(project.root, "modules", "weather")
    await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
    await writeFile(join(moduleRoot, "module.config.ts"), "export default defineModule({})\n")
    await writeFile(join(moduleRoot, "src", "tools", "weather.ts"), objectTool("weather", "sunny"))
    await writeFile(
        join(project.root, "axon.config.ts"),
        `export default defineAgent({ engine: Mock(), modules: ["./modules/weather"] })\n`,
    )
    return project
}

async function withAgent(
    run: (platform: ReturnType<typeof Platform>, project: Awaited<ReturnType<typeof mockAgent>>) => Promise<void>,
): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    try {
        await run(platform, await mockAgent(platform, dir))
    } finally {
        await platform.agents.shutdown()
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

const modulePath = (root: string, file = "weather.ts") => join(root, "modules", "weather", "src", "tools", file)

describe("module lifecycle: a declared module boots with the agent", () => {
    it("its tools are in scope at boot", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(true)
        })
    }, 120_000)

    it("a module whose tools cannot compile still boots the agent", async () => {
        // This asserted a rejection. The agent that could not boot was the one
        // the user needed in order to uninstall the module that broke it —
        // recoverable only by hand-editing axon.config.ts.
        await withAgent(async (platform, project) => {
            await writeFile(modulePath(project.root), BROKEN)

            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            // Alive and answering, without the module's tools.
            await expect(ask(agent, "alive")).resolves.toBeDefined()
            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(false)
        })
    }, 120_000)
})

describe("module lifecycle: editing a module under a live agent", () => {
    it("an edited module tool reloads", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(modulePath(project.root), "export const weather = { forecast: async (): Promise<string> => 'rain' }\n")
            await agent.reload()

            const fns = platform.agents.blueprint!.tools?.find(t => t.name === "weather")?.fns.map(f => f.name)
            expect(fns).toEqual(["weather"])
        })
    }, 120_000)

    it("a module tool breaking mid-session keeps the agent alive", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await writeFile(modulePath(project.root), BROKEN)

            // The reload now SUCCEEDS, having dropped the module's tools. What
            // the old assertion really protected — the session survives, the
            // agent still answers — is unchanged and still asserted.
            await agent.reload()
            expect(platform.agents.session!.id).toBe(sessionId)
            await expect(ask(agent, "alive")).resolves.toBeDefined()
        })
    }, 120_000)

    it("a broken module's tools leave the scope on reload", async () => {
        // The inverse of what this asserted, and deliberately so. Keeping the
        // old declarations meant the model was told about a tool whose source
        // the capsule could no longer load — it would call it and get an error
        // it had no way to anticipate. A capability that is gone must LOOK
        // gone; that is what makes degradation honest rather than merely
        // quiet.
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(modulePath(project.root), BROKEN)
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(false)
        })
    }, 120_000)

    it("repairing a module tool recovers without a restart", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(modulePath(project.root), BROKEN)
            await agent.reload().catch(() => {})

            await writeFile(modulePath(project.root), objectTool("weather", "recovered"))
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(true)
        })
    }, 120_000)

    it("a tool file added to a module appears on reload", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(modulePath(project.root, "extra.ts"), "export const extra = { go: async (): Promise<string> => 'ok' }\n")
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "extra")).toBe(true)
        })
    }, 120_000)

    it("a tool file removed from a module disappears on reload", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(modulePath(project.root, "extra.ts"), "export const extra = { go: async (): Promise<string> => 'ok' }\n")
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            expect(platform.agents.blueprint!.tools?.some(t => t.name === "extra")).toBe(true)

            await rm(modulePath(project.root, "extra.ts"))
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "extra")).toBe(false)
        })
    }, 120_000)

    it("a module in modules/ stays active when undeclared — the directory is the declaration", async () => {
        // Deliberate, and worth pinning because it looks like a leak. Three
        // sources feed the module set (see modules/index.ts): source modules
        // imported in axon.config.ts, local directories under modules/, and
        // registry packages declared as strings. Only the THIRD requires a
        // declaration — a package sitting in node_modules may be a transitive
        // dependency and must never silently add tools.
        //
        // modules/ is different: the author put a directory in their own
        // project, which is itself the declaration. Removing the config entry
        // does not remove the module; deleting the directory does.
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(true)

            await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(true)
        })
    }, 120_000)

    it("deleting the module directory removes its tools", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(true)

            await rm(join(project.root, "modules", "weather"), { recursive: true, force: true })
            await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "weather")).toBe(false)
        })
    }, 120_000)
})
