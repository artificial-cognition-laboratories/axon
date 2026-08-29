import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

function disposableEmail(): string {
    return `test-${crypto.randomUUID()}@axon.dev`
}

describe("store.state", () => {
    it("get() is null when logged out", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.state.get()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("update() throws when logged out — never silently drops a state write", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(() => platform.store.state.update(current => ({ ...current, lastAgent: "barry" }))).toThrow(/Not Logged In/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("get() is an empty object (not null) for a logged-in profile with no state recorded yet", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            expect(platform.store.state.get()).toEqual({})
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("update() then get() round-trips a real field", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            platform.store.state.update(current => ({ ...current, lastAgent: "barry.mk3" }))

            expect(platform.store.state.get()).toEqual({ lastAgent: "barry.mk3" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("update() merges — an unrelated field survives a later update() to a different field", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            platform.store.state.update(current => ({ ...current, lastAgent: "barry.mk3" }))
            platform.store.state.update(current => ({ ...current, lastAgent: "other-agent" }))

            expect(platform.store.state.get()).toEqual({ lastAgent: "other-agent" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("state is isolated per profile — switching profiles switches state", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstId = disposableId()
        const firstEmail = disposableEmail()
        const secondId = disposableId()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            platform.store.profiles.save(firstId, { user: { id: firstId, email: firstEmail }, auth: {} })
            platform.store.state.update(current => ({ ...current, lastAgent: "first-agent" }))

            platform.store.profiles.save(secondId, { user: { id: secondId, email: secondEmail }, auth: {} })
            platform.store.state.update(current => ({ ...current, lastAgent: "second-agent" }))

            expect(platform.store.state.get()).toEqual({ lastAgent: "second-agent" })

            platform.store.profiles.activate(firstEmail)
            expect(platform.store.state.get()).toEqual({ lastAgent: "first-agent" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
