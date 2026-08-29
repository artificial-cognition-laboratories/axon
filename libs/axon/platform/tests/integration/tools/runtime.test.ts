import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { ask } from "../../setup/agent"

/**
 * The receiving end: a live agent whose tools go bad.
 *
 * The scan produces a correct scope or throws (pinned in ./failures.test.ts).
 * This file pins what the RUNTIME does with that — at boot, and again on every
 * reload, which is the same scan running against changed files while a live
 * agent is already answering requests.
 *
 * Reload is the harder half and the one that was broken. A tool that breaks
 * while the agent is running must be recorded where a human can find it: the
 * watcher has no caller to rethrow to, so the session log IS the error surface.
 * And the previous runtime must keep serving — reload is overlap-not-gap by
 * design, so a bad save must not take a running agent down with it.
 *
 * The recovery case matters as much as the failure case. The reported bug was
 * not just that a broken tool produced toolCount: 0 — it was that FIXING the
 * tool did not bring it back, because the empty scan result had been cached
 * against the source hash. An agent you cannot repair by repairing your code is
 * a dead end.
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
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

const toolPath = (root: string, name = "math.ts") => join(root, "src", "tools", name)

describe("agent boot: a broken tool never yields a silently toolless agent", () => {
    it("refuses to boot when a tool cannot be compiled", async () => {
        // The user-visible shape of the reported bug: the agent came up, said
        // nothing, and reported toolCount: 0. Coming up at all was the error.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), BROKEN)

            await expect(platform.agents.spawn(project)).rejects.toBeDefined()
        })
    }, 90_000)

    it("boots with its tools in scope when they are sound", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)

            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "math")).toBe(true)
        })
    }, 90_000)
})

describe("agent reload: a tool breaking mid-session is never swallowed", () => {
    it("records the failure in the session log and rethrows", async () => {
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root), BROKEN)

            await expect(agent.reload()).rejects.toBeDefined()
            expect(platform.agents.session!.log.some(e => e.type === "axon:reload:failed")).toBe(true)
        })
    }, 90_000)

    it("keeps the previous runtime serving after a failed reload", async () => {
        // Overlap, not gap: the live capsule keeps answering until a valid
        // replacement exists.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!
            const sessionId = platform.agents.session!.id

            await writeFile(toolPath(project.root), BROKEN)
            await agent.reload().catch(() => {})

            expect(platform.agents.session!.id).toBe(sessionId)
            await expect(ask(agent, "still alive")).resolves.toBeDefined()
        })
    }, 90_000)

    it("keeps the tools it had before the failed reload", async () => {
        // A failed rescan must not half-apply. The scope the agent is serving
        // stays the last one that was valid.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root), BROKEN)
            await agent.reload().catch(() => {})

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "math")).toBe(true)
        })
    }, 90_000)

    it("recovers when the author fixes the tool — no cache to clear by hand", async () => {
        // The dead end the reported bug created. Fixing the source must be
        // enough; the empty result must never have been cached against the
        // source hash in the first place.
        await withAgent(async (platform, project) => {
            await writeFile(toolPath(project.root), GOOD)
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root), BROKEN)
            await agent.reload().catch(() => {})

            await writeFile(toolPath(project.root), "export function multiply(a: number) { return a }\n")
            await agent.reload()

            const fns = platform.agents.blueprint!.tools?.flatMap(t => t.fns.map(f => f.name)) ?? []
            expect(fns).toContain("multiply")
        })
    }, 90_000)

    it("picks up a tool added after boot", async () => {
        // The counterweight: everything above asserts a failure path, so this
        // pins that the ordinary dev loop still works.
        await withAgent(async (platform, project) => {
            await platform.agents.spawn(project)
            const agent = platform.agents.current!

            await writeFile(toolPath(project.root, "greet.ts"), "export function greet(): string { return 'hi' }\n")
            await agent.reload()

            expect(platform.agents.blueprint!.tools?.some(t => t.name === "greet")).toBe(true)
        })
    }, 90_000)
})
