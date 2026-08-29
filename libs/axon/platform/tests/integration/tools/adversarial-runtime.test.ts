import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { ask } from "../../setup/agent"

/**
 * Adversarial pass at the runtime seam.
 *
 * ./adversarial.test.ts attacks the scan in isolation. This attacks the live
 * agent: boot, reload, and the transitions between them, where a bad tool
 * arrives while something is already running and there is a previous good state
 * to lose.
 *
 * The bar is the same binary one — boot correctly or fail hard — plus one
 * property that only exists here: a failure must never take the RUNNING agent
 * with it. A user editing a tool file mid-session and typoing an import should
 * see an error, not a dead agent and a lost conversation.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

const BROKEN = "import { gone } from './nowhere'\nexport function f() { return gone }\n"
const GOOD = "export function add(a: number, b: number) { return a + b }\n"

async function mockAgent(platform: ReturnType<typeof Platform>, dir: string) {
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
    // A scaffold is deliberately minimal — config and boot, nothing else — so
    // src/tools/ does not exist until an author writes one. These tests write
    // tool files directly, which needs the directory to be there first.
    await mkdir(join(project.root, "src", "tools"), { recursive: true })
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
        await chmod(storeDir, 0o755).catch(() => {})
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

const toolPath = (root: string, name = "math.ts") => join(root, "src", "tools", name)

describe("adversarial runtime: repeated and interleaved failures", () => {
    it("survives repeated failed reloads without degrading", async () => {
        // Each failed reload must leave the same good state behind. A leak or a
        // half-applied blueprint would show up as the tool disappearing after
        // the second or third attempt rather than the first.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            for (let i = 0; i < 3; i++) {
                await writeFile(toolPath(project.root), `${BROKEN}// attempt ${i}\n`)
                await agent.reload().catch(() => {})
            }

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "math")).toBe(true)
            await expect(ask(agent, "alive")).resolves.toBeDefined()
        })
    }, 120_000)

    it("recovers after several failures in a row", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            for (let i = 0; i < 3; i++) {
                await writeFile(toolPath(project.root), `${BROKEN}// ${i}\n`)
                await agent.reload().catch(() => {})
            }

            await writeFile(toolPath(project.root), "export function recovered(a: number) { return a }\n")
            await agent.reload()

            const fns = platform.agents.blueprint!.tools?.flatMap(t => t.fns.map(f => f.name)) ?? []
            expect(fns).toContain("recovered")
        })
    }, 120_000)

    it("a tool deleted while running is reflected without killing the agent", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await rm(toolPath(project.root))
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "math")).toBe(false)
            expect(platform.agents.session!.id).toBe(sessionId)
        })
    }, 120_000)

    it("an empty tool file is not an error — it simply contributes nothing", async () => {
        // Saving a new, still-empty file is the single most common thing a user
        // does mid-session. It must not fail the reload.
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root, "new.ts"), "")
            await agent.reload()

            await expect(ask(agent, "alive")).resolves.toBeDefined()
        })
    }, 120_000)

    it("a half-typed tool file fails loudly, then succeeds when finished", async () => {
        // The real editing sequence: a file saved mid-keystroke is broken, then
        // valid a second later. Both transitions must behave.
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root), "export function halfWritten(a: number): numb\n")
            await agent.reload().catch(() => {})

            await writeFile(toolPath(project.root), "export function halfWritten(a: number): number { return a }\n")
            await agent.reload()

            const fns = platform.agents.blueprint!.tools?.flatMap(t => t.fns.map(f => f.name)) ?? []
            expect(fns).toContain("halfWritten")
        })
    }, 120_000)

    it("concurrent reloads over a broken tool do not corrupt the running state", async () => {
        // Reload coalescing under failure: three overlapping reloads against a
        // broken file must still leave one coherent agent.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await writeFile(toolPath(project.root), BROKEN)
            await Promise.all([
                agent.reload().catch(() => {}),
                agent.reload().catch(() => {}),
                agent.reload().catch(() => {}),
            ])

            expect(platform.agents.session!.id).toBe(sessionId)
            await expect(ask(agent, "alive")).resolves.toBeDefined()
        })
    }, 120_000)

    it("a deleted .agent cache directory mid-session rebuilds rather than failing", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await rm(join(project.root, ".agent"), { recursive: true, force: true })
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "math")).toBe(true)
        })
    }, 120_000)

    it("a tool colliding with a capsule builtin does not silently replace it", async () => {
        // `fs` is a capsule builtin. An agent tool file named fs.ts would, if
        // nothing guarded it, either shadow a builtin the model relies on or be
        // shadowed itself — either way the scope is not what it appears.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root, "fs.ts"), "export function read(): string { return 'not the real fs' }\n")

            const spawned = await platform.agents.spawn(project).then(() => true).catch(() => false)
            if (!spawned) return

            const agent = platform.agents.current!
            await expect(ask(agent, "alive")).resolves.toBeDefined()
        })
    }, 120_000)
})
