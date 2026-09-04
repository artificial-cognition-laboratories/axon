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

describe("cloud.refresh", () => {
    it("exchanges the live session for a real fresh token", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            const before = platform.cloud.client.user.auth.token

            await platform.cloud.refresh()

            const after = platform.cloud.client.user.auth.token
            expect(typeof after).toBe("string")
            expect(after).not.toBe(before)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("re-persists the refreshed token to the active profile on disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            const email = platform.cloud.client.user.auth.user!.email

            await platform.cloud.refresh()

            const record = platform.store.profiles.get(email).record.get()
            expect(record?.auth.accessToken).toBe(platform.cloud.client.user.auth.token)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("a fresh Platform({ version: TEST_VERSION }) picks up the refreshed session from disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const first = await loggedInPlatform(storeDir)
            await first.cloud.refresh()
            const refreshedToken = first.cloud.client.user.auth.token

            const second = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(second.cloud.client.user.auth.token).toBe(refreshedToken)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("throws a clear error when there is no live session to refresh", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            await expect(platform.cloud.refresh()).rejects.toThrow(/no live session|log in first/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("client reference is unchanged after refresh — mutated in place, never swapped", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = await loggedInPlatform(storeDir)
            const client = platform.cloud.client

            await platform.cloud.refresh()

            expect(platform.cloud.client).toBe(client)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)
})
