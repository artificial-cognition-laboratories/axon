import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

const backendUrl = "http://localhost:3099"

/** Stands in for the human clicking "approve" in a browser — Cloud().login() never touches this step. */
async function approveAsTestUser(userCode: string): Promise<void> {
    const res = await fetch(`${backendUrl}/api/user/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_USER.apiKey}` },
        body: JSON.stringify({ user_code: userCode }),
    })
    if (!res.ok) throw new Error(`approve failed: ${res.status} ${await res.text()}`)
}

describe("cloud.login", () => {
    it("completes a real device-flow login and persists the session to the active profile", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            const user = await platform.cloud.login({
                onCode: async authorization => {
                    await approveAsTestUser(authorization.userCode)
                },
            })

            expect(user.id).toBe(TEST_USER.id)
            expect(user.email).toBe(TEST_USER.email)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("authenticated becomes true after login", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.cloud.authenticated).toBe(false)

            await platform.cloud.login({
                onCode: async authorization => { await approveAsTestUser(authorization.userCode) },
            })

            expect(platform.cloud.authenticated).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("client.user.auth.user reflects the real logged-in identity immediately after login — same client, no rebuild", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const client = platform.cloud.client

            await platform.cloud.login({
                onCode: async authorization => { await approveAsTestUser(authorization.userCode) },
            })

            expect(platform.cloud.client).toBe(client) // same reference — login() mutates in place, never swaps
            expect(client.user.auth.user?.id).toBe(TEST_USER.id)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("persists a real session that a fresh Platform({ version: TEST_VERSION }) picks back up from disk", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const first = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await first.cloud.login({
                onCode: async authorization => { await approveAsTestUser(authorization.userCode) },
            })

            const second = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(second.cloud.authenticated).toBe(true)
            expect(second.cloud.client.user.auth.user?.id).toBe(TEST_USER.id)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 20_000)

    it("rejects when aborted before approval completes", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const controller = new AbortController()

            const pending = platform.cloud.login({
                signal: controller.signal,
                onCode: () => { controller.abort() },
            })

            await expect(pending).rejects.toThrow(/aborted/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
