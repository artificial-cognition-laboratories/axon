import { AxonCloud } from "../../src"
import type { AuthSession } from "../../src/user/auth/types"
import { TEST_USER } from "../setup/user"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()

/** Mints a disposable API key via the real create endpoint — refresh()/revoke() tests must never touch the shared seeded TEST_USER.apiKey. */
async function disposableKey(): Promise<{ id: string; key: string }> {
    const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
    const created = await owner.user.keys.create({ name: `disposable-${crypto.randomUUID()}`, scopes: ["keys:manage"] })
    return { id: created.id, key: created.key }
}

function sessionFor(key: string): AuthSession {
    return {
        accessToken: key,
        expiresAt: Date.now() + 60_000,
        user: { id: TEST_USER.id, email: TEST_USER.email, name: "Test User", isStaff: true, memberSince: Date.now() },
    }
}

describe("auth: session lifecycle — construction", () => {
    it("adopts a persisted session at construction — user is available with no network call", () => {
        const cloud = AxonCloud({ baseUrl, session: sessionFor(TEST_USER.apiKey) })

        expect(cloud.user.auth.user?.id).toBe(TEST_USER.id)
    })

    it("a persisted session's accessToken is used as the resolved token", () => {
        const cloud = AxonCloud({ baseUrl, session: sessionFor(TEST_USER.apiKey) })

        expect(cloud.user.auth.token).toBe(TEST_USER.apiKey)
    })

    it("an API-key-backed session (no dots in the token) is never stale", () => {
        const cloud = AxonCloud({ baseUrl, session: sessionFor(TEST_USER.apiKey) })

        expect(cloud.user.auth.stale).toBe(false)
    })
})

describe("auth: session lifecycle — logout", () => {
    it("logout() clears the live session — user becomes undefined", async () => {
        const cloud = AxonCloud({ baseUrl, session: sessionFor(TEST_USER.apiKey) })
        expect(cloud.user.auth.user).toBeDefined()

        await cloud.user.auth.logout()

        expect(cloud.user.auth.user).toBeUndefined()
    })

    it("after logout(), token falls back to whatever the ladder resolves without a session (opts.key here)", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey, session: sessionFor(TEST_USER.apiKey) })

        await cloud.user.auth.logout()

        expect(cloud.user.auth.token).toBe(TEST_USER.apiKey)
    })
})

describe("auth: session lifecycle — refresh (rotation)", () => {
    it("refresh() rotates a disposable API key and adopts the new one", async () => {
        const { key } = await disposableKey()
        const cloud = AxonCloud({ baseUrl, session: sessionFor(key) })

        const rotated = await cloud.user.auth.refresh()

        expect(rotated.accessToken).not.toBe(key)
        expect(rotated.user.id).toBe(TEST_USER.id)
    })

    it("after refresh(), the old key no longer authenticates", async () => {
        const { key } = await disposableKey()
        const cloud = AxonCloud({ baseUrl, session: sessionFor(key) })
        await cloud.user.auth.refresh()

        const stale = AxonCloud({ baseUrl, key })
        await expect(stale.user.auth.me()).rejects.toThrow()
    })

    it("after refresh(), the new key does authenticate as the same user", async () => {
        const { key } = await disposableKey()
        const cloud = AxonCloud({ baseUrl, session: sessionFor(key) })
        const rotated = await cloud.user.auth.refresh()

        const fresh = AxonCloud({ baseUrl, key: rotated.accessToken })
        const me = await fresh.user.auth.me()

        expect(me.id).toBe(TEST_USER.id)
    })

    it("refresh() throws when there is no live session to refresh", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.user.auth.refresh()).rejects.toThrow(/no live session/)
    })

    it("refresh() rejects a token with no matching api_keys row (already rotated/revoked)", async () => {
        const { key, id } = await disposableKey()
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await owner.user.keys.revoke(id)

        const cloud = AxonCloud({ baseUrl, session: sessionFor(key) })
        await expect(cloud.user.auth.refresh()).rejects.toThrow()
    })
})
