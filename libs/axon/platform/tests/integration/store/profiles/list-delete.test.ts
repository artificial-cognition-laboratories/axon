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

describe("store.profiles.list / delete", () => {
    it("list() is empty when no profiles exist", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.profiles.list()).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("list() returns every saved profile keyed by email, not the backend user id", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstEmail = disposableEmail()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: firstEmail }, auth: {} })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: secondEmail }, auth: {} })

            expect(platform.store.profiles.list().sort()).toEqual([firstEmail, secondEmail].sort())
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("list() never includes the index.json pointer file itself", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: "test@axon.dev" }, auth: {} })

            expect(platform.store.profiles.list()).not.toContain("index.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("delete() removes the profile and clears the active pointer when it was the active one", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email }, auth: {} })

            platform.store.profiles.delete(email)

            expect(platform.store.profiles.list()).not.toContain(email)
            expect(platform.store.profiles.current()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("delete() of a non-active profile leaves the active pointer untouched", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const activeEmail = disposableEmail()
        const otherEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: activeEmail }, auth: {} })
            platform.store.profiles.save(disposableId(), { user: { id: disposableId(), email: otherEmail }, auth: {} })
            platform.store.profiles.activate(activeEmail)

            platform.store.profiles.delete(otherEmail)

            expect(platform.store.profiles.current()?.id).toBe(activeEmail)
            expect(platform.store.profiles.list()).not.toContain(otherEmail)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
