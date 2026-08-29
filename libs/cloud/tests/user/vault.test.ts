import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

/** A structurally valid Codex credential the backend will accept and encrypt. */
function fakeCredential(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        accessToken: `fake-access-${crypto.randomUUID()}`,
        refreshToken: `fake-refresh-${crypto.randomUUID()}`,
        expiresAt: Date.now() + 60 * 60_000, // an hour out — never stale, token() must not refresh
        accountId: "acct_test_123",
        connectedAt: Date.now(),
        ...overrides,
    }
}

describe("user.vault.secrets", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()
        await expect(cloud.user.vault.secrets.list()).rejects.toThrow()
    })

    it("roundtrips a secret: set → listed as metadata only → delete", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = `TEST_SECRET_${crypto.randomUUID().slice(0, 8)}`

        await cloud.user.vault.secrets.set(name, "super-secret-value")

        const listed = await cloud.user.vault.secrets.list()
        const entry = listed.find(s => s.name === name)
        expect(entry).toBeDefined()
        // values never come back down through list()
        expect(Object.keys(entry!).sort()).toEqual(["createdAt", "name", "updatedAt"])

        await cloud.user.vault.secrets.delete(name)
        const after = await cloud.user.vault.secrets.list()
        expect(after.find(s => s.name === name)).toBeUndefined()
    })

    it("upserts on repeated set of the same name", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = `TEST_SECRET_${crypto.randomUUID().slice(0, 8)}`

        await cloud.user.vault.secrets.set(name, "one")
        await cloud.user.vault.secrets.set(name, "two")

        const listed = await cloud.user.vault.secrets.list()
        expect(listed.filter(s => s.name === name).length).toBe(1)

        await cloud.user.vault.secrets.delete(name)
    })

    it("is isolated per user", async () => {
        const mine = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const theirs = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const name = `TEST_SECRET_${crypto.randomUUID().slice(0, 8)}`

        await mine.user.vault.secrets.set(name, "mine-only")

        const otherList = await theirs.user.vault.secrets.list()
        expect(otherList.find(s => s.name === name)).toBeUndefined()
        await expect(theirs.user.vault.secrets.delete(name)).rejects.toThrow()

        await mine.user.vault.secrets.delete(name)
    })

    it("404s deleting a secret that does not exist", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(cloud.user.vault.secrets.delete("NEVER_EXISTED")).rejects.toThrow()
    })
})

describe("user.vault.connections.openai", () => {
    // connect() runs an interactive browser PKCE flow — untestable in CI by
    // design. The seam is the upload route: everything after the browser
    // dance is exercised by PUTting a credential directly, exactly what
    // connect() does with the real grant.
    async function upload(cloud: ReturnType<typeof AxonCloud>, credential: Record<string, unknown>) {
        await cloud.user.http.put("/api/user/vault/connections/openai", credential)
    }

    it("requires auth", async () => {
        const cloud = anonymousCloud()
        await expect(cloud.user.vault.connections.openai.status()).rejects.toThrow()
    })

    it("reports disconnected before any credential is uploaded", async () => {
        const cloud = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const status = await cloud.user.vault.connections.openai.status()
        expect(status.connected).toBe(false)
    })

    it("rejects a structurally invalid credential", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(upload(cloud, { accessToken: "only-this" })).rejects.toThrow()
    })

    it("rejects unknown providers", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(
            cloud.user.http.put("/api/user/vault/connections/nonsense", fakeCredential())
        ).rejects.toThrow()
    })

    it("stores a credential, mints narrow tokens, disconnects", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const credential = fakeCredential()

        await upload(cloud, credential)

        const status = await cloud.user.vault.connections.openai.status()
        expect(status).toMatchObject({ connected: true, status: "active" })
        expect(Object.keys(status).sort()).toEqual(["connected", "connectedAt", "status"])

        const token = await cloud.user.vault.connections.openai.token()
        expect(token.accessToken).toBe(credential.accessToken)
        expect(token.accountId).toBe(credential.accountId)
        // the refresh token must never come down to a host
        expect(Object.keys(token).sort()).toEqual(["accessToken", "accountId", "expiresAt"])

        await cloud.user.vault.connections.openai.disconnect()
        const after = await cloud.user.vault.connections.openai.status()
        expect(after.connected).toBe(false)
        await expect(cloud.user.vault.connections.openai.token()).rejects.toThrow()
    })

    it("caches tokens client-side until expiry (one wire call for two token() reads)", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const credential = fakeCredential()
        await upload(cloud, credential)

        const first = await cloud.user.vault.connections.openai.token()
        // rotate the row server-side behind the cache's back
        await upload(cloud, fakeCredential())
        const second = await cloud.user.vault.connections.openai.token()

        // still the cached first token — proves no second wire call happened
        expect(second.accessToken).toBe(first.accessToken)

        await cloud.user.vault.connections.openai.disconnect()
    })

    it("is isolated per user", async () => {
        const mine = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const theirs = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })

        await upload(mine, fakeCredential())

        const otherStatus = await theirs.user.vault.connections.openai.status()
        expect(otherStatus.connected).toBe(false)
        await expect(theirs.user.vault.connections.openai.token()).rejects.toThrow()

        await mine.user.vault.connections.openai.disconnect()
    })

    it("marks the connection broken when refresh fails upstream, and 409s thereafter", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        // already expired → token() must attempt a refresh; the fake refresh
        // token is rejected by auth.openai.com → row flips to broken
        const credential = fakeCredential({ expiresAt: Date.now() - 1000 })
        await upload(cloud, credential)

        try {
            await cloud.user.vault.connections.openai.token()
            throw new Error("expected token refresh to fail")
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            expect(message).not.toContain(credential.accessToken)
            expect(message).not.toContain(credential.refreshToken)
        }

        const status = await cloud.user.vault.connections.openai.status()
        expect(status).toMatchObject({ connected: true, status: "broken" })

        // broken is sticky until reconnect
        await expect(cloud.user.vault.connections.openai.token()).rejects.toThrow()

        // reconnecting (a fresh upload) heals it
        await upload(cloud, fakeCredential())
        const healed = await cloud.user.vault.connections.openai.status()
        expect(healed).toMatchObject({ connected: true, status: "active" })

        await cloud.user.vault.connections.openai.disconnect()
    })
})
