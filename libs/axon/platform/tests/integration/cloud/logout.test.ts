import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

const backendUrl = "http://localhost:3099"

async function approveAsTestUser(userCode: string): Promise<void> {
    const res = await fetch(`${backendUrl}/api/user/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_USER.apiKey}` },
        body: JSON.stringify({ user_code: userCode }),
    })
    if (!res.ok) throw new Error(`approve failed: ${res.status} ${await res.text()}`)
}

async function loggedInPlatform(storeDir: string) {
    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    await platform.cloud.login({
        onCode: async authorization => { await approveAsTestUser(authorization.userCode) },
    })
    return platform
}

describe("cloud.logout", () => {
    it("authenticated becomes false after logout", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            expect(platform.cloud.authenticated).toBe(true)

            await platform.cloud.logout()

            expect(platform.cloud.authenticated).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("keeps the record on disk after logout — REMEMBER_ME keeps auth so switching back can silently reuse it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            const email = platform.cloud.client.user.auth.user!.email

            await platform.cloud.logout()

            const record = platform.store.profiles.get(email).record.get()
            expect(record).not.toBeNull()
            expect(record?.user.email).toBe(email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("deactivates the profile pointer — current() is null afterward", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            expect(platform.store.profiles.current()).not.toBeNull()

            await platform.cloud.logout()

            expect(platform.store.profiles.current()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("logout deactivates the profile and leaves the rest of the record intact", async () => {
        // BYOK providers used to live on ProfileRecord and this asserted they
        // survived a logout. They moved to the profile's own
        // `profile.config.ts` — a FILE logout never opens — so the old
        // assertion could not compile and, more importantly, was asserting
        // about a field that no longer exists.
        //
        // The property it protected is still worth pinning, so it is pinned
        // where the answer now lives: logout DEACTIVATES the profile
        // (REMEMBER_ME is on, so the token deliberately stays on disk for
        // switch() to refresh) and rewrites nothing else. Anything a profile
        // accumulates — the user block here, and by the same construction the
        // config file beside it — has to come back untouched. A logout that
        // reset the whole record would take the user's own configuration with
        // their credential, which is not what logging out means.
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            const email = platform.cloud.client.user.auth.user!.email

            const before = platform.store.profiles.get(email).record.get()!

            await platform.cloud.logout()

            // No profile is active any more — that is what logging out does.
            expect(platform.store.profiles.active()).toBeNull()

            // …and the record itself is untouched, credential included.
            const record = platform.store.profiles.get(email).record.get()
            expect(record).toEqual(before)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("logging out when never logged in does not throw or corrupt state", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            await platform.cloud.logout()

            expect(platform.cloud.authenticated).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
