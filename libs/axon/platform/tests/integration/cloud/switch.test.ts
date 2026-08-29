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

function sessionAuth(userId: string) {
    return {
        accessToken: `axon_fake_token_${userId}`,
        expiresAt: Date.now() + 3600_000,
    }
}

/**
 * A backend that accepts whatever credential it is shown.
 *
 * switch() verifies with the backend now (it did not in development builds,
 * which is precisely the hole that let an unusable credential into the app).
 * The tests below are about DISK mechanics — which profile is active, which
 * session the live client adopted — so they stub acceptance rather than
 * carrying real tokens. The rejection path has its own test above, with a 401.
 */
function acceptingBackend(userId: string, email: string): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
        // /api/user/me/session's shape: the user sits at the top level, which
        // is what Auth.me()'s `record(raw, "session").user` reads.
        user: { id: userId, email, username: email, createdAt: new Date().toISOString() },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    return () => { globalThis.fetch = original }
}

describe("cloud.switch", () => {
    it("production rejects and scrubs a stored credential the backend no longer recognizes", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => new Response(JSON.stringify({
            statusCode: 401,
            statusMessage: "Unauthorized: invalid or expired token",
        }), { status: 401 })) as typeof fetch

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir, distribution: "production" })
            platform.store.profiles.save(id, { user: { id, email }, auth: sessionAuth(id) })

            await expect(platform.cloud.switch(email)).rejects.toThrow(/Profile Has No Session/)
            expect(platform.store.profiles.get(email).record.get()?.auth).toEqual({})
            expect(platform.store.profiles.current()).toBeNull()
            expect(platform.cloud.client.user.auth.token).toBeUndefined()
        } finally {
            globalThis.fetch = originalFetch
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("activates a different on-disk profile", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstId = disposableId()
        const firstEmail = disposableEmail()
        const secondId = disposableId()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(firstId, { user: { id: firstId, email: firstEmail }, auth: sessionAuth(firstId) })
            platform.store.profiles.save(secondId, { user: { id: secondId, email: secondEmail }, auth: sessionAuth(secondId) })

            const restore = acceptingBackend(firstId, firstEmail)
            try {
                await platform.cloud.switch(firstEmail)
            } finally {
                restore()
            }

            expect(platform.store.profiles.current()?.id).toBe(firstEmail)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("throws on an unknown profile, listing the known ones", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const knownId = disposableId()
        const knownEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(knownId, { user: { id: knownId, email: knownEmail }, auth: sessionAuth(knownId) })

            await expect(platform.cloud.switch("totally-unknown@axon.dev")).rejects.toThrow(/unknown profile/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("throws on an unknown profile when there are no profiles at all", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            await expect(platform.cloud.switch("totally-unknown@axon.dev")).rejects.toThrow(/unknown profile/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("throws PROFILE_NOT_AUTHENTICATED when the target profile has no stored session", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const id = disposableId()
        const email = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(id, { user: { id, email }, auth: {} })

            await expect(platform.cloud.switch(email)).rejects.toThrow(/Profile Has No Session/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("adopts the target profile's session into the live client — same client reference, real identity swap", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstId = disposableId()
        const firstEmail = disposableEmail()
        const secondId = disposableId()
        const secondEmail = disposableEmail()

        try {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            seed.store.profiles.save(firstId, { user: { id: firstId, email: firstEmail }, auth: sessionAuth(firstId) })
            seed.store.profiles.save(secondId, { user: { id: secondId, email: secondEmail }, auth: sessionAuth(secondId) })
            seed.store.profiles.activate(firstEmail)

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const clientBefore = platform.cloud.client
            expect(clientBefore.user.auth.user?.id).toBe(firstId)

            const restore = acceptingBackend(secondId, secondEmail)
            try {
                await platform.cloud.switch(secondEmail)
            } finally {
                restore()
            }

            // Disk pointer moved...
            expect(platform.store.profiles.current()?.id).toBe(secondEmail)
            // ...and the SAME client reference now reflects the new identity.
            expect(platform.cloud.client).toBe(clientBefore)
            expect(platform.cloud.client.user.auth.user?.id).toBe(secondId)
            expect(platform.cloud.client.user.auth.token).toBe(`axon_fake_token_${secondId}`)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("a fresh Platform({ version: TEST_VERSION }) constructed after switch() adopts the newly-active profile", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const firstId = disposableId()
        const firstEmail = disposableEmail()
        const secondId = disposableId()
        const secondEmail = disposableEmail()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.profiles.save(firstId, { user: { id: firstId, email: firstEmail }, auth: sessionAuth(firstId) })
            platform.store.profiles.save(secondId, { user: { id: secondId, email: secondEmail }, auth: sessionAuth(secondId) })

            const restore = acceptingBackend(secondId, secondEmail)
            try {
                await platform.cloud.switch(secondEmail)
            } finally {
                restore()
            }

            const reopened = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(reopened.cloud.client.user.auth.token).toBe(`axon_fake_token_${secondId}`)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
