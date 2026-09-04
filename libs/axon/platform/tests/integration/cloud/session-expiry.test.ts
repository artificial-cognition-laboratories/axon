import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"
import { stubFetch } from "../../setup/fetch"

/**
 * A credential can die WHILE the app is running.
 *
 * Revoked from the web, expired past refresh, account disabled — and boot
 * validation cannot catch any of it, because boot already passed. The user was
 * left inside an app where every request 401'd, with no route back to a login
 * short of restarting.
 *
 * So every authenticated response passes one seam (Http.request), and a 401
 * there scrubs the credential and tells subscribers. The TUI shuts its auth
 * gate on that signal; these pin the platform half.
 *
 * The auth ladder's OWN calls are excluded — me() and refresh() treat a 401 as
 * their own answer, and routing them here would make validate() re-enter
 * itself. That exclusion is tested below, because a loop there would be an
 * infinite one.
 */

function disposable(): { id: string; email: string } {
    const id = `test-user-${crypto.randomUUID()}`
    return { id, email: `${id}@axon.dev` }
}

async function withStore(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "axon-expiry-"))
    try {
        await body(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

async function withFetch(stub: typeof fetch, body: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch
    globalThis.fetch = stub
    try {
        await body()
    } finally {
        globalThis.fetch = original
    }
}

const ok = (id: string, email: string) => new Response(JSON.stringify({
    user: { id, email, username: email, createdAt: new Date().toISOString() },
}), { status: 200, headers: { "content-type": "application/json" } })

const unauthorized = () => new Response(JSON.stringify({ statusCode: 401, statusMessage: "Unauthorized" }), { status: 401 })

/** Let the fire-and-forget observer settle before asserting on it. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe("a credential that dies mid-session", () => {
    it("notifies subscribers and scrubs it", async () => {
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_live_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            let fired = 0
            platform.cloud.onSessionExpired(() => { fired++ })

            // Boot is fine — this is the state the old code never left.
            await withFetch(stubFetch(async () => ok(id, email)), async () => {
                expect(await platform.cloud.validate()).toBe("valid")
            })

            // ...then the credential is revoked from the web.
            await withFetch(stubFetch(async () => unauthorized()), async () => {
                await platform.cloud.client.user.billing.ledger.list({ limit: 1 }).catch(() => {})
                await settle()
            })

            expect(fired).toBe(1)
            expect(platform.cloud.authenticated).toBe(false)
            expect(platform.store.profiles.get(email).record.get()?.auth).toEqual({})
        })
    })

    it("still throws the original error to the caller", async () => {
        // Observation only: a subscriber must not swallow or alter the failure
        // the calling code is waiting for.
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_live_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.cloud.onSessionExpired(() => {})

            await withFetch(stubFetch(async () => unauthorized()), async () => {
                await expect(platform.cloud.client.user.billing.ledger.list({ limit: 1 })).rejects.toThrow()
            })
        })
    })

    it("survives a subscriber that throws", async () => {
        // One bad listener must not stop the others being told, nor break the
        // request path it is riding on.
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_live_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            let reached = false
            platform.cloud.onSessionExpired(() => { throw new Error("subscriber exploded") })
            platform.cloud.onSessionExpired(() => { reached = true })

            await withFetch(stubFetch(async () => unauthorized()), async () => {
                await platform.cloud.client.user.billing.ledger.list({ limit: 1 }).catch(() => {})
                await settle()
            })

            expect(reached).toBe(true)
        })
    })

    it("reports one transition even when several requests 401 at once", async () => {
        // A burst is the normal case — a page with three panels all fail
        // together. The user must not see three session-died signals.
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_live_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            let fired = 0
            platform.cloud.onSessionExpired(() => { fired++ })

            await withFetch(stubFetch(async () => unauthorized()), async () => {
                await Promise.all([
                    platform.cloud.client.user.billing.ledger.list({ limit: 1 }).catch(() => {}),
                    platform.cloud.client.user.keys.list().catch(() => {}),
                    platform.cloud.client.user.billing.ledger.list({ limit: 1 }).catch(() => {}),
                ])
                await settle()
            })

            expect(fired).toBe(1)
        })
    })

    it("unsubscribes cleanly", async () => {
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_live_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            let fired = 0
            const off = platform.cloud.onSessionExpired(() => { fired++ })
            off()

            await withFetch(stubFetch(async () => unauthorized()), async () => {
                await platform.cloud.client.user.billing.ledger.list({ limit: 1 }).catch(() => {})
                await settle()
            })

            expect(fired).toBe(0)
        })
    })
})

describe("the auth ladder does not re-enter the observer", () => {
    it("stays silent when validate() itself gets a 401", async () => {
        // validate() → me() → 401. If that fired the observer, the observer
        // would scrub and notify for a check that is ALREADY reporting the
        // same fact — and a listener calling validate() would loop forever.
        const { id, email } = disposable()

        await withStore(async store => {
            const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            seed.store.profiles.save(id, { user: { id, email }, auth: { apiKey: "axon_dead_key" } })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            let fired = 0
            platform.cloud.onSessionExpired(() => { fired++ })

            await withFetch(stubFetch(async () => unauthorized()), async () => {
                expect(await platform.cloud.validate()).toBe("rejected")
                await settle()
            })

            // The rejection was reported by validate()'s return value, once.
            expect(fired).toBe(0)
            expect(platform.cloud.authenticated).toBe(false)
        })
    })
})
