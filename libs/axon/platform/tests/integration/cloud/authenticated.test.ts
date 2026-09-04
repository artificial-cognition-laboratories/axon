import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

describe("cloud.authenticated", () => {
    it("false when no profile exists on disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("true when the active profile has a stored apiKey", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(id, { user: { id, email: "test@axon.dev" }, auth: { apiKey: "axon_fake_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("true when the active profile has a stored accessToken (no apiKey)", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(id, {
                user: { id, email: "test@axon.dev" },
                auth: { accessToken: "fake-access-token", expiresAt: Date.now() + 3600_000 },
            })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("false when a profile exists but its auth block is empty", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(id, { user: { id, email: "test@axon.dev" }, auth: {} })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("false after the profile is deactivated, even though its record still exists on disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(id, { user: { id, email: "test@axon.dev" }, auth: { apiKey: "axon_fake_key" } })
            seed.store.profiles.deactivate()

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("reflects disk state live — it re-reads on every access, not cached at construction", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(false)

            platform.store.profiles.save(id, { user: { id, email: "test@axon.dev" }, auth: { apiKey: "axon_fake_key" } })

            expect(platform.cloud.authenticated).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
