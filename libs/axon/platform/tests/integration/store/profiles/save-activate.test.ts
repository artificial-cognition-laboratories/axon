import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

function disposableEmail(): string {
    return `test-${crypto.randomUUID()}@axon.dev`
}

describe("store.profiles.save / activate / deactivate", () => {
    it("save() writes the record and activates it, keyed by email", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            expect(platform.store.profiles.current()?.id).toBe(email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("save() overwrites an existing record for the same email", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email }, auth: {} })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email }, auth: { accessToken: "second" } })

            expect(platform.store.profiles.current()?.record.auth.accessToken).toBe("second")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("activate() switches the active pointer without touching the record", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstEmail = disposableEmail()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: firstEmail }, auth: {} })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: secondEmail }, auth: {} })

            platform.store.profiles.activate(firstEmail)

            expect(platform.store.profiles.current()?.id).toBe(firstEmail)
            // second profile's own record is untouched
            expect(platform.store.profiles.get(secondEmail).record.get()?.user.email).toBe(secondEmail)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("deactivate() clears the active pointer — current() and active() go back to null", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email }, auth: {} })

            platform.store.profiles.deactivate()

            expect(platform.store.profiles.current()).toBeNull()
            expect(platform.store.profiles.active()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("deactivate() does not delete the profile's own record — reactivating restores it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email }, auth: {} })
            platform.store.profiles.deactivate()

            platform.store.profiles.activate(email)

            expect(platform.store.profiles.current()?.record.user.email).toBe(email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
