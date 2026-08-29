import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * A running agent reacting to its own source changing.
 *
 * Reload rescans the project, regenerates the type frame, and pushes the fresh
 * blueprint through the live runtime's update() — no reboot. The runtime keeps
 * its identity across it, which is the property everything else depends on: a
 * session survives an edit.
 *
 * Failures have nowhere to propagate (a watcher has no caller), so the session
 * log IS the error surface. That is asserted here rather than assumed.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

async function mockAgent(platform: ReturnType<typeof Platform>, dir: string) {
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
    // A scaffold is deliberately minimal — config and boot, nothing else — so
    // src/tools/ does not exist until an author writes one. These tests write
    // tool files directly to exercise the rescan, which needs the directory
    // to be there first.
    await mkdir(join(project.root, "src", "tools"), { recursive: true })
    return project
}

/**
 * A tool whose type cannot be resolved — the shape of the real @axon/arxiv
 * failure, where a type used in an exported signature has no definition.
 * Degrades the module without stopping the scan producing a blueprint.
 */
const BROKEN_TOOL = "import type { Gone } from './nowhere'\nexport function broken(): Gone { return null as never }\n"

/**
 * Scaffold an agent that declares one local source module, so tests can break
 * and fix that module's tool across reloads.
 *
 * The module has to be DECLARED before boot — `modules:` is read from
 * axon.config.ts at scan time, so one added afterwards is not part of the
 * agent. Its tool starts healthy; `moduleTool` is the file to rewrite.
 */
async function agentWithModule(platform: ReturnType<typeof Platform>, dir: string) {
    const project = await mockAgent(platform, dir)
    const moduleRoot = join(project.root, "modules", "broken")
    await mkdir(join(moduleRoot, "src", "tools"), { recursive: true })
    await writeFile(join(moduleRoot, "module.config.ts"), "export default defineModule({})\n")
    const moduleTool = join(moduleRoot, "src", "tools", "thing.ts")
    await writeFile(moduleTool, "export function ok(): string { return 'ok' }\n")
    await writeFile(
        join(project.root, "axon.config.ts"),
        "export default defineAgent({ engine: Mock(), modules: [\"./modules/broken\"] })\n",
    )
    return { project, moduleTool }
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

/** withAgent, for an agent that declares a local source module. */
async function withModuleAgent(
    run: (
        platform: ReturnType<typeof Platform>,
        fixture: Awaited<ReturnType<typeof agentWithModule>>,
    ) => Promise<void>,
): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    try {
        await run(platform, await agentWithModule(platform, dir))
    } finally {
        await platform.agents.shutdown()
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

describe("agent reload", () => {
    it("keeps the session across a reload — an edit is not a new conversation", async () => {
        await withAgent(async (platform, project) => {
            const instance = await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await agent.reload()

            expect(platform.agents.session!.id).toBe(sessionId)
            expect(platform.agents.get(instance.sessionId)).toBe(instance)
            expect(platform.agents.list()).toHaveLength(1)
        })
    }, 90_000)

    it("picks up a tool added after boot — the rescan is what makes dev work", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            const before = platform.agents.blueprint!.tools?.length ?? 0
            await writeFile(
                join(project.root, "src", "tools", "greet.ts"),
                "export function greet(): string { return 'hi' }\n",
            )

            await agent.reload()

            expect(platform.agents.blueprint!.tools?.length ?? 0).toBeGreaterThan(before)
            expect(platform.agents.blueprint!.tools?.some(tool => tool.name === "greet")).toBe(true)
        })
    }, 90_000)

    it("drops a field the author removed — a reload is the whole config re-read, not a merge", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(
                join(project.root, "axon.config.ts"),
                "export default defineAgent({ engine: Mock(), description: \"before\" })\n",
            )
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            expect(platform.agents.blueprint!.config.description).toBe("before")

            await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
            await agent.reload()

            expect(platform.agents.blueprint!.config.description).toBeUndefined()
        })
    }, 90_000)

    it("coalesces overlapping reloads instead of running them concurrently", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            // Three reloads with no awaits between them: the second and third
            // land while the first is still in flight.
            await Promise.all([agent.reload(), agent.reload(), agent.reload()])

            expect(platform.agents.session!.id).toBe(sessionId)
            await expect(agent.current.axon.request("still alive")).resolves.toBeDefined()
        })
    }, 90_000)

    it("records a failed reload in the session log and rethrows", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            // A config that cannot evaluate is no agent — Config() throws, and
            // the failure happens BEFORE runtime.update() can open its own span.
            await writeFile(join(project.root, "axon.config.ts"), "this is not valid typescript {{{\n")

            await expect(agent.reload()).rejects.toBeDefined()

            const log = platform.agents.session!.log
            expect(log.some(entry => entry.type === "axon:reload:failed")).toBe(true)
            // The span is opened and closed together — a bare :failed would
            // leave an unpaired bracket for anything reading the log.
            expect(log.some(entry => entry.type === "axon:reload:start")).toBe(true)
        })
    }, 90_000)

    /**
     * A persistent warning is announced once, not once per reload.
     *
     * Every build re-derives the whole warning set from scratch, so a module
     * whose tools will not compile is rediscovered by boot, by prepare, by
     * load, and by every reload after — and a reload is what a file save, an
     * install and a cognet rebuild each trigger. Emitting on rediscovery
     * stacked identical cards until the timeline read as many problems rather
     * than one persistent one.
     *
     * A local source module with a tool that cannot compile is the exact
     * shape of the real case (@axon/arxiv), without needing a registry: the
     * module degrades, the agent boots, and a warning is produced by every
     * scan for as long as the file stays broken.
     */
    /**
     * Broken BEFORE boot — the case the reload tests below cannot reach.
     *
     * boot() concatenates two scans: prepare() runs a full blueprint.load()
     * internally and returns its warnings, then boot() loads again. A module
     * already broken when the agent starts is therefore found by BOTH and
     * arrives in one array twice, at the same millisecond.
     *
     * That is the shipped duplicate — two identical AX-BLUEPRINT-002 cards for
     * one broken module, on every boot and every install. The reload tests miss
     * it entirely because a reload is a single scan, so the warning can only
     * arrive once there however wrong the dedup is.
     */
    it("announces a warning once when the module is already broken at boot", async () => {
        await withModuleAgent(async (platform, { project, moduleTool }) => {
            // Broken before spawn, so prepare and load each discover it.
            await writeFile(moduleTool, BROKEN_TOOL)

            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            // Counted by IDENTITY, not by total: a scan legitimately produces
            // several DIFFERENT warnings, and the property under test is that
            // no single one is announced twice. Asserting a bare total would
            // couple this to how many distinct things the fixture happens to
            // trip, which is not what broke.
            const warnings = platform.agents.session!.log
                .filter(entry => entry.type === "build:warning")
                .map(entry => {
                    const data = entry.data as { domain?: string; message?: string }
                    return `${data.domain} ${data.message}`
                })

            expect(warnings.length).toBeGreaterThan(0)
            expect(warnings.length).toBe(new Set(warnings).size)
            // The one that matters: the broken tool, announced exactly once.
            expect(warnings.filter(key => key.startsWith("tools:"))).toHaveLength(1)
        })
    }, 90_000)

    it("announces a persistent warning once, not once per reload", async () => {
        await withModuleAgent(async (platform, { project, moduleTool }) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            const countWarnings = (): number =>
                platform.agents.session!.log.filter(entry => entry.type === "build:warning").length

            await writeFile(moduleTool, BROKEN_TOOL)

            await agent.reload()
            const afterFirst = countWarnings()
            expect(afterFirst).toBeGreaterThan(0)

            // Nothing changed, so nothing new is wrong. The scan still finds
            // the same broken module every time; the log must not grow.
            await agent.reload()
            await agent.reload()

            expect(countWarnings()).toBe(afterFirst)
        })
    }, 90_000)

    it("announces again if a fixed warning comes back", async () => {
        await withModuleAgent(async (platform, { project, moduleTool }) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            const countWarnings = (): number =>
                platform.agents.session!.log.filter(entry => entry.type === "build:warning").length

            const toolFile = moduleTool
            await writeFile(toolFile, BROKEN_TOOL)
            await agent.reload()
            const afterBreak = countWarnings()
            expect(afterBreak).toBeGreaterThan(0)

            // Fixed: the warning drops out of the set the scan produces.
            await writeFile(toolFile, "export function ok(): string { return 'ok' }\n")
            await agent.reload()
            expect(countWarnings()).toBe(afterBreak)

            // Broken again. Suppression must not outlive the condition — this
            // is why the live set is REPLACED each build rather than merged.
            await writeFile(toolFile, BROKEN_TOOL)
            await agent.reload()

            expect(countWarnings()).toBeGreaterThan(afterBreak)
        })
    }, 90_000)

    it("survives a failed reload — the previous blueprint stays live", async () => {
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await writeFile(join(project.root, "axon.config.ts"), "broken {{{\n")
            await expect(agent.reload()).rejects.toBeDefined()

            // Still the same runtime, still answering: a bad edit must not take
            // the agent down, only refuse to become the new truth.
            expect(platform.agents.session!.id).toBe(sessionId)
            await expect(agent.current.axon.request("after the bad edit")).resolves.toBeDefined()
        })
    }, 90_000)
})
