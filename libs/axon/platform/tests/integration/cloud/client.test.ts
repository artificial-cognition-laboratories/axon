import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

describe("cloud.client", () => {
    it("is a real AxonCloudClient — user/registry/cloud all present", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            expect(platform.cloud.client.user).toBeDefined()
            expect(platform.cloud.client.registry).toBeDefined()
            expect(platform.cloud.client.cloud).toBeDefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("with no profile, the client is still usable — anonymous, no user identity", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            expect(platform.cloud.client.user.auth.user).toBeUndefined()
            expect(platform.cloud.client.user.auth.token).toBeUndefined()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("a profile with a real apiKey produces a client that can make a real authenticated call", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(TEST_USER.id, {
                user: { id: TEST_USER.id, email: TEST_USER.email },
                auth: { apiKey: TEST_USER.apiKey },
            })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const me = await platform.cloud.client.user.auth.me()

            expect(me.id).toBe(TEST_USER.id)
            expect(me.email).toBe(TEST_USER.email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("client.user.auth.token resolves to the stored apiKey directly, with no session round trip needed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(TEST_USER.id, {
                user: { id: TEST_USER.id, email: TEST_USER.email },
                auth: { apiKey: TEST_USER.apiKey },
            })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            expect(platform.cloud.client.user.auth.token).toBe(TEST_USER.apiKey)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("an invalid stored apiKey surfaces a real 401 rather than silently degrading to anonymous", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save("bad-user", {
                user: { id: "bad-user", email: "bad@axon.dev" },
                auth: { apiKey: "axon_totally_not_a_real_key" },
            })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            await expect(platform.cloud.client.user.auth.me()).rejects.toThrow()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
