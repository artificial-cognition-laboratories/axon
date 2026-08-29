import { AxonCloud } from "../../src"
import type { AuthSession } from "../../src/user/auth/types"
import { TEST_USER, OTHER_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

function sessionFor(user: { id: string; email: string }, key: string): AuthSession {
    return {
        accessToken: key,
        expiresAt: Date.now() + 60_000,
        user: { id: user.id, email: user.email, name: "Test User", isStaff: false, memberSince: Date.now() },
    }
}

describe("auth: adopt", () => {
    it("adopts a session in place — user reflects the newly adopted identity, no wire call", () => {
        const cloud = anonymousCloud()
        expect(cloud.user.auth.user).toBeUndefined()

        cloud.user.auth.adopt(sessionFor(TEST_USER, TEST_USER.apiKey))

        expect(cloud.user.auth.user?.id).toBe(TEST_USER.id)
    })

    it("token resolves to the adopted session's accessToken", () => {
        const cloud = anonymousCloud()

        cloud.user.auth.adopt(sessionFor(TEST_USER, TEST_USER.apiKey))

        expect(cloud.user.auth.token).toBe(TEST_USER.apiKey)
    })

    it("replaces a previously adopted (or logged-in) session entirely — no merge with the old identity", () => {
        const cloud = anonymousCloud()
        cloud.user.auth.adopt(sessionFor(TEST_USER, TEST_USER.apiKey))

        cloud.user.auth.adopt(sessionFor(OTHER_USER, OTHER_USER.apiKey))

        expect(cloud.user.auth.user?.id).toBe(OTHER_USER.id)
        expect(cloud.user.auth.token).toBe(OTHER_USER.apiKey)
    })

    it("the adopted session actually authenticates real requests as that user", async () => {
        const cloud = anonymousCloud()
        cloud.user.auth.adopt(sessionFor(TEST_USER, TEST_USER.apiKey))

        const me = await cloud.user.auth.me()

        expect(me.id).toBe(TEST_USER.id)
    })

    it("adopting a session clears any in-flight pendingToken state from a prior partial login", async () => {
        const cloud = anonymousCloud()
        const controller = new AbortController()

        // Start a login and abort it immediately — leaves no live session,
        // but exercises the same internal state adopt() must clear cleanly.
        await cloud.user.auth.login({
            signal: controller.signal,
            onVerification: () => controller.abort(),
        }).catch(() => { /* expected — aborted before approval */ })

        cloud.user.auth.adopt(sessionFor(TEST_USER, TEST_USER.apiKey))

        expect(cloud.user.auth.token).toBe(TEST_USER.apiKey)
        expect(cloud.user.auth.user?.id).toBe(TEST_USER.id)
    })
})
