import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { ask } from "../../setup/agent"

/**
 * Narrow a spawned instance to its local runtime.
 *
 * InstanceT gained a local/remote union (`source`), so the runtime lives at
 * `instance.source.agent` rather than `instance.agent`. Every spawn in this
 * file is a local project; this asserts that rather than optional-chaining
 * through it, so a remote instance would fail loudly instead of reading
 * undefined.
 */
function local(instance: InstanceT): Extract<InstanceT["source"], { kind: "local" | "linked" }> {
    // "On this machine", not "in this heap". Both local kinds have a project
    // and an agent handle; only a deployment has neither. Spawning produces
    // LINKED instances now, so asserting `kind === "local"` failed every test
    // in this file for a distinction they were never making.
    if (instance.source.kind === "remote") throw new Error(`expected a local instance, got ${instance.source.kind}`)
    return instance.source
}

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agents.spawn", () => {
    it("spawns a real project — instance is registered, focused, and reflected by current/project/active", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await platform.projects.create("agent", { name, dir })

            const instance = await platform.agents.spawn(project)

            expect(platform.agents.list()).toHaveLength(1)
            expect(platform.agents.get(instance.sessionId)).toBe(instance)
            expect(platform.agents.focused).toBe(instance)
            expect(platform.agents.current).toBe(local(instance).agent)
            expect(platform.agents.project).toBe(project)
            expect(platform.agents.active).toBe(true)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("runs two instances at once — fully independent, second spawn focuses itself", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const firstName = disposableName()
        const secondName = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const first = await platform.projects.create("agent", { name: firstName, dir })
            const second = await platform.projects.create("agent", { name: secondName, dir })

            const a = await platform.agents.spawn(first)
            const b = await platform.agents.spawn(second)

            expect(platform.agents.list()).toHaveLength(2)
            expect(a.sessionId).not.toBe(b.sessionId)
            expect(platform.agents.focused).toBe(b) // spawning is an act of attention
            expect(local(platform.agents.get(a.sessionId)!).agent.sessionId).toBe(a.sessionId)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("runs two instances of the same agent with separate cognet kernels", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await platform.projects.create("agent", { name, dir })
            await Bun.write(join(project.root, "axon.config.ts"), "export default defineAgent({ engine: Mock() })\n")

            const first = await platform.agents.spawn(project)
            const second = await platform.agents.spawn(project)

            expect(platform.agents.list()).toHaveLength(2)
            expect(first.sessionId).not.toBe(second.sessionId)
            // Two spawns are two independent agents. Compared by SESSION rather
            // than by kernel identity: a linked agent has no in-heap kernel to
            // compare, and the session is what actually distinguishes them.
            expect(local(first).agent.sessionId).not.toBe(local(second).agent.sessionId)

            // Both compiled brains author against ambient globals. Their
            // wakes must remain bound to their own host scope even while
            // they overlap in one JS process, and the first must still be
            // usable after the second settles.
            await Promise.all([
                ask(local(first).agent, "from first"),
                ask(local(second).agent, "from second"),
            ])
            await expect(ask(local(first).agent, "first again")).resolves.toBeDefined()
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("refuses to resume a sessionId that already has a live instance", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await platform.projects.create("agent", { name, dir })
            const instance = await platform.agents.spawn(project)

            await expect(platform.agents.spawn(project, { session: instance.sessionId }))
                .rejects.toThrow(/Session Is Already Running/)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("spawn(project, { session }) resumes an on-disk session under the same id", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            const project = await platform.projects.create("agent", { name, dir })

            const first = await platform.agents.spawn(project)
            const sessionId = first.sessionId
            await platform.agents.stop(sessionId)

            const resumed = await platform.agents.spawn(project, { session: sessionId })

            expect(resumed.sessionId).toBe(sessionId)
            // the resumed runtime loaded the same durable log, not a fresh one
            expect(local(resumed).agent.session.log.some(e => e.type === "axon:session:restored")).toBe(true)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("spawn(name) resolves a named agent under the active profile and spawns it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const name = disposableName()

        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        try {
            platform.store.profiles.save(TEST_USER.id, { user: { id: TEST_USER.id, email: TEST_USER.email }, auth: { apiKey: TEST_USER.apiKey } })

            const agentsRoot = platform.store.profiles.active()!.agents.root
            await platform.projects.create("agent", { name, dir: agentsRoot })

            await platform.agents.spawn(name)

            expect(platform.agents.active).toBe(true)
            expect(platform.agents.project?.name).toBe(name)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("spawn(name) throws NOT_AUTHENTICATED when there is no active profile", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            await expect(platform.agents.spawn("anything")).rejects.toThrow(/Not Logged In/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("spawn(name) surfaces AGENT_NOT_FOUND for an unknown name", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(TEST_USER.id, { user: { id: TEST_USER.id, email: TEST_USER.email }, auth: { apiKey: TEST_USER.apiKey } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            // Not "Project Not Found": a NAME that matches nothing means
            // "not installed anywhere", whose fix is `axon install` — a
            // different problem from a PATH that holds no project.
            await expect(platform.agents.spawn("totally-unknown-agent")).rejects.toThrow(/Agent Not Found/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
