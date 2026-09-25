import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { PRODUCTION_API_BASE } from "@arcforge/cloud"
import { Platform } from "@arcforge/platform/platform"
import { storeRoot } from "@arcforge/platform/store"
import { TEST_VERSION, TEST_FRAMEWORK } from "../setup/user"
import { stubFetch, Transport } from "../setup/fetch"

/**
 * Production is hermetic.
 *
 * An installed app must not be redirectable by whatever happens to be in the
 * caller's environment: not the backend it talks to, not the credentials it
 * presents. Source development deliberately keeps both, which is why the two
 * builds must also never share a credential store — logging into staging from
 * a checkout would otherwise re-point the installed app.
 */
describe("Axon distribution environment", () => {
    test("each build keeps its own credential store", () => {
        // The suite preload points AXON_STORE_ROOT at a temp directory so no
        // test can write the developer's real profile. This test is about the
        // DEFAULT resolution, so it asks the question with the override off.
        const override = process.env.AXON_STORE_ROOT
        delete process.env.AXON_STORE_ROOT
        try {
            expect(storeRoot("production")).toBe(join(homedir(), ".axon"))
            expect(storeRoot("development")).toBe(join(homedir(), ".axon-dev"))
            expect(storeRoot("production")).not.toBe(storeRoot("development"))
        } finally {
            if (override !== undefined) process.env.AXON_STORE_ROOT = override
        }
    })

    /**
     * The separation survives relocation.
     *
     * `AXON_STORE_ROOT` exists so tests cannot reach a real profile — a theme
     * unit test once persisted `theme: "test-reset-theme"` into the
     * developer's own `profile.config.ts`. The first version of it returned the
     * override verbatim, which made production and development share one
     * directory and defeated the very property the test above pins. A seam that
     * can switch off a safety invariant is worse than the leak it closes.
     */
    test("relocating the store does not merge the two builds", () => {
        const override = process.env.AXON_STORE_ROOT
        process.env.AXON_STORE_ROOT = "/tmp/axon-relocated-store"
        try {
            expect(storeRoot("production")).not.toBe(storeRoot("development"))
            expect(storeRoot("production")).toStartWith("/tmp/axon-relocated-store")
            expect(storeRoot("development")).toStartWith("/tmp/axon-relocated-store")
        } finally {
            if (override === undefined) delete process.env.AXON_STORE_ROOT
            else process.env.AXON_STORE_ROOT = override
        }
    })

    test("a production client ignores ambient staging endpoint and credentials", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-production-environment-"))
        const net = Transport()
        const originalConnectToken = process.env.AXON_CONNECT_TOKEN
        const originalApiKey = process.env.AXON_API_KEY
        process.env.AXON_CONNECT_TOKEN = "stale-development-token"
        process.env.AXON_API_KEY = "stale-development-key"
        let requested = ""
        net.use(stubFetch(async input => {
            requested = String(input)
            return new Response(JSON.stringify({
                package: "@arcforge/axon",
                channel: "latest",
                version: "2.0.22",
            }), { status: 200 })
        }))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution: "production", fetch: net.fetch })
            expect(platform.cloud.client.user.auth.token).toBeUndefined()
            expect(platform.cloud.client.user.auth.apiKey).toBeUndefined()
            await platform.cloud.client.cloud.releases.axon()
            expect(requested).toBe(`${PRODUCTION_API_BASE}/api/releases/axon`)
        } finally {
            if (originalConnectToken === undefined) delete process.env.AXON_CONNECT_TOKEN
            else process.env.AXON_CONNECT_TOKEN = originalConnectToken
            if (originalApiKey === undefined) delete process.env.AXON_API_KEY
            else process.env.AXON_API_KEY = originalApiKey
            await rm(store, { recursive: true, force: true })
        }
    })

    test("a development client accepts an ambient credential — the checkout convenience production refuses", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-development-environment-"))
        const originalApiKey = process.env.AXON_API_KEY
        process.env.AXON_API_KEY = "axon_ambient_development_key"

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution: "development" })
            expect(platform.cloud.client.user.auth.apiKey).toBe("axon_ambient_development_key")
        } finally {
            if (originalApiKey === undefined) delete process.env.AXON_API_KEY
            else process.env.AXON_API_KEY = originalApiKey
            await rm(store, { recursive: true, force: true })
        }
    })
})
