import { API_KEY_SCOPES, AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

/** Stands in for the human clicking "approve" in a browser — the one step AxonCloud's client deliberately doesn't expose. */
async function approveAsTestUser(userCode: string): Promise<{ apiKeyId: string }> {
    const res = await fetch(`${baseUrl}/api/user/device/approve`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TEST_USER.apiKey}`,
        },
        body: JSON.stringify({ user_code: userCode }),
    })
    if (!res.ok) throw new Error(`approve failed: ${res.status} ${await res.text()}`)
    const body = await res.json() as { device: { apiKeyId: string } }
    return { apiKeyId: body.device.apiKeyId }
}

async function authorize(): Promise<{ deviceCode: string; userCode: string }> {
    const res = await fetch(`${baseUrl}/api/user/device/authorize`, { method: "POST" })
    if (!res.ok) throw new Error(`authorize failed: ${res.status} ${await res.text()}`)
    const body = await res.json() as { device_code: string; user_code: string }
    return { deviceCode: body.device_code, userCode: body.user_code }
}

async function poll(deviceCode: string): Promise<Response> {
    return fetch(`${baseUrl}/api/user/device/poll?device_code=${encodeURIComponent(deviceCode)}`)
}

describe("auth: device flow", () => {
    it("login() surfaces a well-formed device authorization via onVerification", async () => {
        // authorize() isn't exposed standalone on AxonCloud's Auth — it only
        // ever surfaces through login()'s onVerification callback. Abort
        // immediately once we've inspected the shape, before any polling starts.
        const cloud = anonymousCloud()
        const controller = new AbortController()
        let seen: { userCode: string; verificationUri: string; deviceCode: string } | null = null

        const pending = cloud.user.auth.login({
            signal: controller.signal,
            onVerification: (authorization) => {
                seen = {
                    userCode: authorization.userCode,
                    verificationUri: authorization.verificationUri,
                    deviceCode: authorization.deviceCode,
                }
                controller.abort()
            },
        }).catch(() => null)

        await pending

        expect(seen).not.toBeNull()
        expect(seen!.userCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/)
        expect(seen!.verificationUri).toBe(`${baseUrl.replace(/:\d+$/, ":3100")}/auth/device`)
    })

    it("completes end-to-end: authorize -> approve -> poll -> adopted session", async () => {
        const cloud = anonymousCloud()
        let approvedKeyId: string | undefined

        const session = await cloud.user.auth.login({
            onVerification: async (authorization) => {
                approvedKeyId = (await approveAsTestUser(authorization.userCode)).apiKeyId
            },
        })

        expect(session.user.id).toBe(TEST_USER.id)
        expect(session.user.email).toBe(TEST_USER.email)
        expect(typeof session.accessToken).toBe("string")

        // A grant is a SET of scopes. Compare it as one: the backend and this
        // client each declare the vocabulary in their own file, and the order a
        // new scope happens to be inserted at is not a fact about the grant.
        // Asserting on array order made adding `prompts:*` fail a test that had
        // nothing to do with prompts.
        const sessionKey = (await cloud.user.keys.list()).find(key => key.id === approvedKeyId)
        expect([...(sessionKey?.scopes ?? [])].sort()).toEqual([...API_KEY_SCOPES].sort())
    }, 20_000)

    it("after login(), auth.user reflects the adopted session", async () => {
        const cloud = anonymousCloud()

        await cloud.user.auth.login({
            onVerification: async (authorization) => {
                await approveAsTestUser(authorization.userCode)
            },
        })

        expect(cloud.user.auth.user?.id).toBe(TEST_USER.id)
    }, 20_000)

    it("after login(), token resolves to the new session's accessToken, not the old ladder rungs", async () => {
        const cloud = anonymousCloud()

        const session = await cloud.user.auth.login({
            onVerification: async (authorization) => {
                await approveAsTestUser(authorization.userCode)
            },
        })

        expect(cloud.user.auth.token).toBe(session.accessToken)
    }, 20_000)

    it("approving with a garbage user_code fails rather than silently minting a key for nobody", async () => {
        await expect(approveAsTestUser("ZZZ-000")).rejects.toThrow()
    })

    it("delivers an approved device key exactly once", async () => {
        const authorization = await authorize()
        await approveAsTestUser(authorization.userCode)

        const first = await poll(authorization.deviceCode)
        expect(first.ok).toBe(true)
        const approved = await first.json() as { status: string; access_token?: string }
        expect(approved.status).toBe("approved")
        expect(approved.access_token).toMatch(/^axon_/)

        const authenticated = AxonCloud({ baseUrl, key: approved.access_token })
        expect((await authenticated.user.auth.me()).id).toBe(TEST_USER.id)

        const replay = await poll(authorization.deviceCode)
        expect(replay.ok).toBe(false)
        expect(await replay.text()).not.toContain(approved.access_token!)
    })

    it("login() rejects when aborted before approval completes", async () => {
        const cloud = anonymousCloud()
        const controller = new AbortController()

        const pending = cloud.user.auth.login({
            signal: controller.signal,
            onVerification: () => {
                controller.abort()
            },
        })

        await expect(pending).rejects.toThrow(/aborted/)
    })
})
