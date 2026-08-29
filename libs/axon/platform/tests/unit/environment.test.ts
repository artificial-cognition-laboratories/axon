import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { PRODUCTION_API_BASE } from "@arcforge/cloud"
import { Platform } from "@arcforge/platform/platform"
import { storeRoot } from "@arcforge/platform/store"
import { TEST_VERSION, TEST_FRAMEWORK } from "../setup/user"

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
        expect(storeRoot("production")).toBe(join(homedir(), ".axon"))
        expect(storeRoot("development")).toBe(join(homedir(), ".axon-dev"))
        expect(storeRoot("production")).not.toBe(storeRoot("development"))
    })

    test("a production client ignores ambient staging endpoint and credentials", async () => {
        const store = await mkdtemp(join(tmpdir(), "axon-production-environment-"))
        const originalFetch = globalThis.fetch
        const originalConnectToken = process.env.AXON_CONNECT_TOKEN
        const originalApiKey = process.env.AXON_API_KEY
        process.env.AXON_CONNECT_TOKEN = "stale-development-token"
        process.env.AXON_API_KEY = "stale-development-key"
        let requested = ""
        globalThis.fetch = (async input => {
            requested = String(input)
            return new Response(JSON.stringify({
                package: "@arcforge/axon",
                channel: "latest",
                version: "2.0.22",
            }), { status: 200 })
        }) as typeof fetch

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution: "production" })
            expect(platform.cloud.client.user.auth.token).toBeUndefined()
            expect(platform.cloud.client.user.auth.apiKey).toBeUndefined()
            await platform.cloud.client.cloud.releases.axon()
            expect(requested).toBe(`${PRODUCTION_API_BASE}/api/releases/axon`)
        } finally {
            globalThis.fetch = originalFetch
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
