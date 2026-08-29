import { AxonCloud, HttpError } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("auth: api key", () => {
    it("token and apiKey resolve to the constructed key", () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        expect(cloud.user.auth.token).toBe(TEST_USER.apiKey)
        expect(cloud.user.auth.apiKey).toBe(TEST_USER.apiKey)
    })

    it("user is undefined until a session exists — an api key alone isn't a session", () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        expect(cloud.user.auth.user).toBeUndefined()
    })

    it("me() resolves the real seeded identity from staging", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const me = await cloud.user.auth.me()

        expect(me.id).toBe(TEST_USER.id)
        expect(me.email).toBe(TEST_USER.email)
    })

    it("me() reflects isStaff derived live from real org membership, not a stored column", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const me = await cloud.user.auth.me()

        expect(me.isStaff).toBe(true)
    })

    it("me() does not mutate auth.user as a side effect when there is no live session yet", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await cloud.user.auth.me()

        // me() only syncs an *existing* session's user — constructing with a
        // bare key never creates one, so auth.user must still be undefined
        expect(cloud.user.auth.user).toBeUndefined()
    })

    it("an invalid key fails loudly (401), not silently as an empty/anonymous identity", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        await expect(cloud.user.auth.me()).rejects.toThrow(HttpError)
    })

    it("an invalid key surfaces a 401 status specifically", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        try {
            await cloud.user.auth.me()
            throw new Error("expected me() to reject")
        } catch (err) {
            expect(err).toBeInstanceOf(HttpError)
            expect((err as HttpError).status).toBe(401)
        }
    })

    it("with no key at all, an auth-requiring call fails loudly rather than resolving anonymously", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.auth.me()).rejects.toThrow(HttpError)
    })

    it("stale is false for a bare api-key client — there is no session to go stale", () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        expect(cloud.user.auth.stale).toBe(false)
    })
})
