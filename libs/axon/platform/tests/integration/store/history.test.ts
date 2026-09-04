import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

function disposableEmail(): string {
    return `test-${crypto.randomUUID()}@axon.dev`
}

describe("store.history", () => {
    it("append() throws when logged out — never silently drops a sent message", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(() => platform.store.history.append("hello", null)).toThrow(/Not Logged In/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("recent() is empty when logged out", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.history.recent()).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("append() then recent() round-trips a real entry for the active profile", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            platform.store.history.append("hello there", "barry.mk3")

            const entries = platform.store.history.recent()
            expect(entries).toHaveLength(1)
            expect(entries[0]?.content).toBe("hello there")
            expect(entries[0]?.agentName).toBe("barry.mk3")
            expect(typeof entries[0]?.id).toBe("string")
            expect(typeof entries[0]?.createdAt).toBe("string")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("agentName is null when no agent was running", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            platform.store.history.append("no agent yet", null)

            expect(platform.store.history.recent()[0]?.agentName).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("recent() returns newest-first", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            platform.store.history.append("first", null)
            platform.store.history.append("second", null)
            platform.store.history.append("third", null)

            const entries = platform.store.history.recent()
            expect(entries.map(e => e.content)).toEqual(["third", "second", "first"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("recent(limit) caps the number of entries returned, still newest-first", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            for (let i = 0; i < 5; i++) platform.store.history.append(`message-${i}`, null)

            const entries = platform.store.history.recent(2)
            expect(entries.map(e => e.content)).toEqual(["message-4", "message-3"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("history is isolated per profile — switching profiles switches history", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstId = disposableId()
        const firstEmail = disposableEmail()
        const secondId = disposableId()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            platform.store.profiles.save(firstId, { user: { id: firstId, email: firstEmail }, auth: {} })
            platform.store.history.append("first profile message", null)

            platform.store.profiles.save(secondId, { user: { id: secondId, email: secondEmail }, auth: {} })
            platform.store.history.append("second profile message", null)

            expect(platform.store.history.recent().map(e => e.content)).toEqual(["second profile message"])

            platform.store.profiles.activate(firstEmail)
            expect(platform.store.history.recent().map(e => e.content)).toEqual(["first profile message"])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
