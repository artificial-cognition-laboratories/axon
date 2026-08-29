import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("user.keys.list", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.keys.list()).rejects.toThrow()
    })

    it("includes the seeded TEST_USER key as metadata only — no plaintext", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const keys = await cloud.user.keys.list()

        expect(keys.length).toBeGreaterThan(0)
        for (const key of keys) {
            expect(typeof key.id).toBe("string")
            expect("key" in key).toBe(false)
        }
    })
})

describe("user.keys.create", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.keys.create({ name: "test-key", scopes: ["keys:manage"] })).rejects.toThrow()
    })

    it("mints a real usable axon_... key and returns it exactly once", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const created = await cloud.user.keys.create({ name: `test-key-${crypto.randomUUID().slice(0, 8)}`, scopes: ["keys:manage"] })

        try {
            expect(created.key.startsWith("axon_")).toBe(true)

            const asNewKey = AxonCloud({ baseUrl, key: created.key })
            const me = await asNewKey.user.auth.me()
            expect(me.id).toBe(TEST_USER.id)
        } finally {
            await cloud.user.keys.revoke(created.id)
        }
    })

    it("the new key appears in list() afterward, as metadata only", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = `test-key-list-${crypto.randomUUID().slice(0, 8)}`

        const created = await cloud.user.keys.create({ name, scopes: ["keys:manage"] })

        try {
            const keys = await cloud.user.keys.list()
            const found = keys.find(k => k.id === created.id)

            expect(found).toBeDefined()
            expect(found?.name).toBe(name)
            expect(found?.isActive).toBe(true)
        } finally {
            await cloud.user.keys.revoke(created.id)
        }
    })
})

describe("user.keys.revoke", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.keys.revoke("nonexistent")).rejects.toThrow()
    })

    it("rejects an unknown key id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.user.keys.revoke(crypto.randomUUID())).rejects.toThrow()
    })

    it("revokes the key — it disappears from list() and can no longer authenticate", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const created = await cloud.user.keys.create({ name: `test-key-revoke-${crypto.randomUUID().slice(0, 8)}`, scopes: ["keys:manage"] })

        await cloud.user.keys.revoke(created.id)

        const keys = await cloud.user.keys.list()
        expect(keys.find(k => k.id === created.id)).toBeUndefined()

        const asRevokedKey = AxonCloud({ baseUrl, key: created.key })
        await expect(asRevokedKey.user.auth.me()).rejects.toThrow()
    })

    it("a caller can't revoke another user's key", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        const created = await owner.user.keys.create({ name: `test-key-isolation-${crypto.randomUUID().slice(0, 8)}`, scopes: ["keys:manage"] })

        try {
            await expect(intruder.user.keys.revoke(created.id)).rejects.toThrow()
        } finally {
            await owner.user.keys.revoke(created.id)
        }
    })
})
