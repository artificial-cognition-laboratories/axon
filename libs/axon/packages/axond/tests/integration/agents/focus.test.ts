import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authenticated } from "../../setup/supervised"
import { describe, it, expect } from "bun:test"
import type { InstanceT } from "@arcforge/platform/build/runtime"

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

describe("agents.focus / agents.stop", () => {
    it("focus() is pure selection — both instances stay live, projections follow the focused one", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const firstName = disposableName()
        const secondName = disposableName()

        const platform = authenticated(storeDir)
        try {
            const first = await platform.projects.create("agent", { name: firstName, dir })
            const second = await platform.projects.create("agent", { name: secondName, dir })

            const a = await platform.agents.spawn(first)
            const b = await platform.agents.spawn(second)
            expect(platform.agents.focused).toBe(b)

            platform.agents.focus(a.sessionId)

            expect(platform.agents.focused).toBe(a)
            expect(platform.agents.current).toBe(local(a).agent)
            expect(platform.agents.project).toBe(first)
            // nothing was torn down — the unfocused instance is still running
            expect(platform.agents.list()).toHaveLength(2)
            expect(platform.agents.get(b.sessionId)).toBe(b)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("focus() throws SESSION_NOT_RUNNING for a sessionId with no live instance", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = authenticated(storeDir)

            expect(() => platform.agents.focus("no-such-session")).toThrow(/Session Is Not Running/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("stop() removes one instance — focus falls to the most recent survivor", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const firstName = disposableName()
        const secondName = disposableName()

        const platform = authenticated(storeDir)
        try {
            const first = await platform.projects.create("agent", { name: firstName, dir })
            const second = await platform.projects.create("agent", { name: secondName, dir })

            const a = await platform.agents.spawn(first)
            const b = await platform.agents.spawn(second)

            await platform.agents.stop(b.sessionId)

            expect(platform.agents.list()).toHaveLength(1)
            expect(platform.agents.focused).toBe(a)
            expect(platform.agents.get(b.sessionId)).toBeNull()
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("stop() of an unknown sessionId is a safe no-op", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = authenticated(storeDir)

            await expect(platform.agents.stop("no-such-session")).resolves.toBeUndefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("sessions() lists on-disk logs across the profile, flagging running ones", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const { TEST_USER } = await import("../../setup/user")
        const name = disposableName()

        const platform = authenticated(storeDir)
        try {
            platform.store.profiles.save(TEST_USER.id, { user: { id: TEST_USER.id, email: TEST_USER.email }, auth: { apiKey: TEST_USER.apiKey } })

            const agentsRoot = platform.store.profiles.active()!.agents.root
            await platform.projects.create("agent", { name, dir: agentsRoot })

            const instance = await platform.agents.spawn(name)

            const live = platform.agents.sessions()
            expect(live.some(r => r.sessionId === instance.sessionId && r.agent === name && r.running)).toBe(true)

            await platform.agents.stop(instance.sessionId)

            const stopped = platform.agents.sessions()
            expect(stopped.some(r => r.sessionId === instance.sessionId && !r.running)).toBe(true)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 30_000)
})
