import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

function disposableEmail(): string {
    return `test-${crypto.randomUUID()}@axon.dev`
}

describe("store.profiles.active / current", () => {
    it("active() is null when logged out", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.profiles.active()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("current() is null when logged out", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.profiles.current()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("active() returns the scoped handle for the saved profile, keyed by email", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            expect(platform.store.profiles.active()?.id).toBe(email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("current() resolves to the saved record", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            const current = platform.store.profiles.current()
            expect(current?.id).toBe(email)
            expect(current?.record.user.email).toBe(email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("current() is null when the active pointer references a profile whose record is missing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            // Point the active pointer at a profile that was never actually saved.
            platform.store.profiles.activate(email)

            expect(platform.store.profiles.current()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("active() still returns a handle for an orphaned pointer (it doesn't check the record exists)", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.activate(email)

            expect(platform.store.profiles.active()?.id).toBe(email)
            expect(platform.store.profiles.active()?.record.get()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
