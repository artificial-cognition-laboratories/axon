import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authenticated } from "../../setup/supervised"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agents.shutdown", () => {
    it("tears down every running instance — registry empties, current/project/active reset", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const firstName = disposableName()
        const secondName = disposableName()

        const platform = authenticated(storeDir)
        try {
            const first = await platform.projects.create("agent", { name: firstName, dir })
            const second = await platform.projects.create("agent", { name: secondName, dir })
            await platform.agents.spawn(first)
            await platform.agents.spawn(second)
            expect(platform.agents.list()).toHaveLength(2)

            await platform.agents.shutdown()

            expect(platform.agents.list()).toHaveLength(0)
            expect(platform.agents.focused).toBeNull()
            expect(platform.agents.current).toBeNull()
            expect(platform.agents.project).toBeNull()
            expect(platform.agents.active).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)

    it("is a safe no-op when nothing is running", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = authenticated(storeDir)

            await expect(platform.agents.shutdown()).resolves.toBeUndefined()
            expect(platform.agents.active).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("calling shutdown() twice in a row is safe — the second call is a no-op", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        const platform = authenticated(storeDir)
        try {
            const project = await platform.projects.create("agent", { name, dir })
            await platform.agents.spawn(project)

            await platform.agents.shutdown()
            await expect(platform.agents.shutdown()).resolves.toBeUndefined()

            expect(platform.agents.active).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 20_000)

    it("after shutdown, spawn() starts fresh — new instance, new session", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const firstName = disposableName()
        const secondName = disposableName()

        const platform = authenticated(storeDir)
        try {
            const first = await platform.projects.create("agent", { name: firstName, dir })
            const second = await platform.projects.create("agent", { name: secondName, dir })

            const before = await platform.agents.spawn(first)
            await platform.agents.shutdown()

            const after = await platform.agents.spawn(second)

            expect(platform.agents.list()).toHaveLength(1)
            expect(platform.agents.focused).toBe(after)
            expect(after.sessionId).not.toBe(before.sessionId)
            expect(platform.agents.project).toBe(second)
        } finally {
            await platform.agents.shutdown()
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)
})
