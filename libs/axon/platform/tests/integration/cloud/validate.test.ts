import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"
import { stubFetch } from "../../setup/fetch"

/**
 * cloud.validate() — is the stored credential actually usable?
 *
 * This is the auth gate's only source of truth. It exists because
 * `cloud.authenticated` answers a DIFFERENT question ("does a credential exist
 * on disk"), and a user reported being locked out when those two disagreed: a
 * revoked key read as authenticated, the TUI let them in, and every request
 * 401'd.
 *
 * Three outcomes, because they need three different responses:
 *
 *   valid       proceed
 *   rejected    scrub and force a login
 *   unreachable preserve the credential, offer a retry — an outage is NOT a
 *               rejection, and destroying a good credential over flaky wifi
 *               would be its own bug
 *
 * These run against BOTH distributions. Validation used to be skipped entirely
 * in development (`validateCredentials: false`), which is why the reported bug
 * could not be reproduced locally and survived to a user.
 */

const DISTRIBUTIONS = ["development", "production"] as const

function disposable(): { id: string; email: string } {
    const id = `test-user-${crypto.randomUUID()}`
    return { id, email: `${id}@axon.dev` }
}

/** Run `body` with fetch replaced, always restoring it. */
async function withFetch(stub: typeof fetch, body: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch
    globalThis.fetch = stub
    try {
        await body()
    } finally {
        globalThis.fetch = original
    }
}

async function withStore(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "axon-validate-"))
    try {
        await body(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

const accepts = (id: string, email: string): typeof fetch =>
    stubFetch(async () => new Response(JSON.stringify({
        user: { id, email, username: email, createdAt: new Date().toISOString() },
    }), { status: 200, headers: { "content-type": "application/json" } }))

const refuses: typeof fetch =
    stubFetch(async () => new Response(JSON.stringify({ statusCode: 401, statusMessage: "Unauthorized" }), { status: 401 }))

const offline: typeof fetch = stubFetch(async () => { throw new TypeError("fetch failed") })

/** A stored session that is not stale — expiry well in the future. */
const liveAuth = { accessToken: "axon_stored_token", expiresAt: Date.now() + 3600_000 }

describe.each([...DISTRIBUTIONS])("cloud.validate (%s build)", distribution => {
    it("confirms a credential the backend accepts", async () => {
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution })
            platform.store.profiles.save(id, { user: { id, email }, auth: liveAuth })

            await withFetch(accepts(id, email), async () => {
                expect(await platform.cloud.validate()).toBe("valid")
            })
        })
    })

    it("rejects and SCRUBS a credential the backend refuses", async () => {
        // The reported bug: without this, a revoked key stays on disk reading
        // as authenticated forever.
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution })
            platform.store.profiles.save(id, { user: { id, email }, auth: liveAuth })

            await withFetch(refuses, async () => {
                expect(await platform.cloud.validate()).toBe("rejected")
            })

            expect(platform.store.profiles.get(email).record.get()?.auth).toEqual({})
            expect(platform.store.profiles.current()).toBeNull()
            expect(platform.cloud.authenticated).toBe(false)
        })
    })

    it("reports an outage as unreachable and PRESERVES the credential", async () => {
        // A working credential must survive a flaky network. Scrubbing here
        // would force a device flow on a user whose session was fine.
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution })
            platform.store.profiles.save(id, { user: { id, email }, auth: liveAuth })

            await withFetch(offline, async () => {
                expect(await platform.cloud.validate()).toBe("unreachable")
            })

            expect(platform.store.profiles.get(email).record.get()?.auth.accessToken).toBe(liveAuth.accessToken)
            expect(platform.cloud.authenticated).toBe(true)
        })
    })

    it("is rejected when there is no profile at all", async () => {
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store, distribution })

            expect(await platform.cloud.validate()).toBe("rejected")
        })
    })
})

describe("validate never trusts disk alone", () => {
    it("treats a credential that only EXISTS as unverified — the reported bug", async () => {
        // `authenticated` is true for any stored credential, including a
        // revoked one. That is the gap the auth gate fell through: it must
        // never be the thing granting access.
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_revoked_key" } })

            expect(platform.cloud.authenticated).toBe(true) // disk says yes...

            await withFetch(refuses, async () => {
                expect(await platform.cloud.validate()).toBe("rejected") // ...the backend says no
            })
        })
    })
})

describe("a real fault is never disguised as an outage", () => {
    it("throws on a 500 rather than reporting unreachable", async () => {
        // "unreachable" tells the user to check their connection. Saying that
        // about a broken backend would hide the real failure.
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.store.profiles.save(id, { user: { id, email }, auth: liveAuth })

            const boom: typeof fetch = stubFetch(async () => new Response("boom", { status: 500 }))
            await withFetch(boom, async () => {
                await expect(platform.cloud.validate()).rejects.toThrow()
            })
        })
    })

    it("throws on a malformed payload rather than reporting unreachable", async () => {
        const { id, email } = disposable()
        await withStore(async store => {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.store.profiles.save(id, { user: { id, email }, auth: liveAuth })

            const garbage: typeof fetch =
                stubFetch(async () => new Response(JSON.stringify({ user: "not-an-object" }), {
                    status: 200, headers: { "content-type": "application/json" },
                }))

            await withFetch(garbage, async () => {
                await expect(platform.cloud.validate()).rejects.toThrow()
            })
        })
    })
})
