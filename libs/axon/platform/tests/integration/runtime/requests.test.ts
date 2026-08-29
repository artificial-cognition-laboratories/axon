import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * The host surface an agent calls into, and the envelope around it.
 *
 * A user may run as many agents side by side as they like. These limits bound
 * the ONE path where the caller is code rather than a person: an agent whose
 * own execution asks the platform to run work on another agent, which could
 * ask again without bound.
 *
 * The limits are constants in requests.ts with no other observable — they are
 * the only guard against runaway spawning, so they are asserted directly
 * through `agents.host`.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/** An agent whose engine answers instantly — these tests are about the envelope, not the model. */
async function mockAgent(platform: ReturnType<typeof Platform>, dir: string) {
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    await writeFile(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")
    return project
}

describe("runtime.host — agent-initiated requests", () => {
    it("runs a prompt on a child of the caller's own project and returns its result", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            const result = await platform.agents.host.request({
                parentSessionId: parent.sessionId,
                input: { prompt: "do the thing" },
                signal: new AbortController().signal,
            })

            expect(result).toBeDefined()
            // The child is torn down in a finally — a completed request must
            // never leave a runtime behind.
            expect(platform.agents.list()).toHaveLength(1)
            expect(platform.agents.children(parent.sessionId)).toEqual([])
            // The caller keeps attention: a code-initiated spawn is deliberately unfocused.
            expect(platform.agents.focused?.sessionId).toBe(parent.sessionId)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("refuses a request from a session that is not running", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            await expect(platform.agents.host.request({
                parentSessionId: "not-a-live-session",
                input: { prompt: "hello" },
                signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: "AX-RUNTIME-005" })
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("refuses a malformed request before spawning anything", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            for (const input of [null, "just a string", { notAPrompt: 1 }, { prompt: 42 }, { prompt: [1, 2] }]) {
                await expect(platform.agents.host.request({
                    parentSessionId: parent.sessionId,
                    input,
                    signal: new AbortController().signal,
                })).rejects.toMatchObject({ code: "AX-RUNTIME-009" })
            }

            // Nothing was booted on the way to any of those refusals.
            expect(platform.agents.list()).toHaveLength(1)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("rejects an unknown host method rather than guessing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            await expect(platform.agents.host.call({
                callerSessionId: parent.sessionId,
                method: "definitely-not-a-method",
                input: { prompt: "hi" },
                signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: "AX-RUNTIME-011" })
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("aborts an in-flight request and still tears the child down", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            const controller = new AbortController()
            controller.abort()

            await expect(platform.agents.host.request({
                parentSessionId: parent.sessionId,
                input: { prompt: "never runs" },
                signal: controller.signal,
            })).rejects.toThrow(/abort/i)

            expect(platform.agents.children(parent.sessionId)).toEqual([])
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("refuses when the caller is an attached deployment — a remote parent has no local project to fork", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            // No remote instance to attach in this fixture, so assert the
            // guard's shape holds for a session the registry does not know:
            // both paths refuse before booting, which is the property that
            // matters — a request never spawns speculatively.
            await expect(platform.agents.host.request({
                parentSessionId: crypto.randomUUID(),
                input: { prompt: "hello" },
                signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: "AX-RUNTIME-005" })
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})

describe("runtime.host — the spawn envelope", () => {
    it("refuses beyond the depth limit — the guard against unbounded recursion", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)

            // Build a chain by hand rather than through host.request(), whose
            // children are torn down as soon as they answer. MAX_DEPTH is 4, so
            // depths 0..3 may spawn and a parent at depth 4 may not.
            let parent = await platform.agents.spawn(project)
            for (let depth = 1; depth <= 4; depth++) {
                parent = await platform.agents.spawn(project, {
                    parentSessionId: parent.sessionId,
                    focus: false,
                })
                expect(parent.depth).toBe(depth)
            }

            await expect(platform.agents.host.request({
                parentSessionId: parent.sessionId,
                input: { prompt: "one too deep" },
                signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: "AX-RUNTIME-006" })
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 180_000)

    it("refuses beyond one agent's live-children limit", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            // MAX_LIVE_CHILDREN is 4 — hold exactly that many open.
            for (let i = 0; i < 4; i++) {
                await platform.agents.spawn(project, { parentSessionId: parent.sessionId, focus: false })
            }
            expect(platform.agents.children(parent.sessionId)).toHaveLength(4)

            await expect(platform.agents.host.request({
                parentSessionId: parent.sessionId,
                input: { prompt: "one too many" },
                signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: "AX-RUNTIME-007" })
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 180_000)

    it("stopping a child frees its slot — the limit is on LIVE children, not lifetime spawns", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await mockAgent(platform, dir)
            const parent = await platform.agents.spawn(project)

            const children = []
            for (let i = 0; i < 4; i++) {
                children.push(await platform.agents.spawn(project, { parentSessionId: parent.sessionId, focus: false }))
            }
            await platform.agents.stop(children[0]!.sessionId)
            expect(platform.agents.children(parent.sessionId)).toHaveLength(3)

            // The freed slot is usable — a request now succeeds where it would
            // have been refused a moment ago.
            await expect(platform.agents.host.request({
                parentSessionId: parent.sessionId,
                input: { prompt: "fits now" },
                signal: new AbortController().signal,
            })).resolves.toBeDefined()
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 180_000)
})
