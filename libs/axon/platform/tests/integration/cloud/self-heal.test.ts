import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"
import { stubFetch } from "../../setup/fetch"

/**
 * A stale session heals itself. Only a spent one asks the user for anything.
 *
 * The requirement is that EVERY path ends with a working session: if the token
 * is merely old, refresh it silently; if refresh is refused, the credential is
 * spent and the user does a full login. What must never happen is a device
 * flow demanded of someone whose session only needed rotating — that is a
 * working session thrown away for nothing.
 *
 * validate() owns this ladder (refresh, then verify) so there is ONE
 * implementation. switch() used to carry its own copy, which drifted: it
 * refreshed without persisting the result and treated an outage as a dead
 * profile.
 */

/** A structurally-real JWT whose exp is `seconds` from now. Only exp is read. */
function jwtExpiring(seconds: number): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + seconds })}.sig`
}

function disposable(): { id: string; email: string } {
    const id = `test-user-${crypto.randomUUID()}`
    return { id, email: `${id}@axon.dev` }
}

async function withStore(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "axon-selfheal-"))
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

/** Routes /api/auth/refresh and /api/user/me/session, recording what was called. */
function backend(opts: { refresh: "ok" | "refused"; freshToken?: string }): { stub: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const stub = (async (url: unknown) => {
        const path = String(url)
        calls.push(path.replace(/^https?:\/\/[^/]+/, ""))

        if (path.includes("/api/auth/refresh")) {
            if (opts.refresh === "refused") {
                return new Response(JSON.stringify({ statusCode: 401, statusMessage: "Unauthorized" }), { status: 401 })
            }
            return new Response(JSON.stringify({ access_token: opts.freshToken }), {
                status: 200, headers: { "content-type": "application/json" },
            })
        }
        return new Response(JSON.stringify({
            user: { id: "u", email: "u@axon.dev", username: "u@axon.dev", createdAt: new Date().toISOString() },
        }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    return { stub, calls }
}

/** Write a profile with `token` as its session, before the platform under test exists. */
function seed(store: string, id: string, email: string, token: string): void {
    Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store }).store.profiles.save(id, {
        user: { id, email },
        auth: { accessToken: token, expiresAt: Date.now() + 30_000 },
    })
}

describe("a stale token heals without asking the user", () => {
    it("refreshes, then verifies — and persists the new token", async () => {
        const { id, email } = disposable()
        const fresh = jwtExpiring(3600)

        await withStore(async store => {
            // Expiring inside the refresh buffer — `stale` is true. Seeded
            // BEFORE the platform under test: Cloud() adopts the active
            // profile's session at construction, so a profile saved afterwards
            // would leave the client with no session to refresh.
            seed(store, id, email, jwtExpiring(30))
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })

            const { stub, calls } = backend({ refresh: "ok", freshToken: fresh })
            await withFetch(stub, async () => {
                expect(await platform.cloud.validate()).toBe("valid")
            })

            // It refreshed rather than going straight to a verdict...
            expect(calls.some(path => path.includes("/api/auth/refresh"))).toBe(true)
            // ...and the rotated token is on disk, so the next boot is clean.
            expect(platform.store.profiles.get(email).record.get()?.auth.accessToken).toBe(fresh)
        })
    })

    it("does not refresh a token that is still good", async () => {
        // A pointless refresh on every boot would rotate credentials for no
        // reason and add a round trip to every start.
        const { id, email } = disposable()

        await withStore(async store => {
            seed(store, id, email, jwtExpiring(3600))
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })

            const { stub, calls } = backend({ refresh: "ok" })
            await withFetch(stub, async () => {
                expect(await platform.cloud.validate()).toBe("valid")
            })

            expect(calls.some(path => path.includes("/api/auth/refresh"))).toBe(false)
        })
    })
})

describe("a spent token falls back to a full login", () => {
    it("is rejected and scrubbed when refresh itself is refused", async () => {
        // The credential is genuinely dead — nothing to salvage, so it must be
        // removed rather than left on disk reading as authenticated.
        const { id, email } = disposable()

        await withStore(async store => {
            seed(store, id, email, jwtExpiring(30))
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })

            const { stub } = backend({ refresh: "refused" })
            await withFetch(stub, async () => {
                expect(await platform.cloud.validate()).toBe("rejected")
            })

            expect(platform.store.profiles.get(email).record.get()?.auth).toEqual({})
            expect(platform.cloud.authenticated).toBe(false)
        })
    })

    it("keeps a stale credential when refresh cannot reach the backend", async () => {
        // Offline with an old token is not a dead token. Preserve it and let
        // the user retry — a login attempt would fail against the same outage.
        const { id, email } = disposable()
        const stored = jwtExpiring(30)

        await withStore(async store => {
            seed(store, id, email, stored)
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })

            const offline: typeof fetch = stubFetch(async () => { throw new TypeError("fetch failed") })
            await withFetch(offline, async () => {
                expect(await platform.cloud.validate()).toBe("unreachable")
            })

            expect(platform.store.profiles.get(email).record.get()?.auth.accessToken).toBe(stored)
        })
    })
})

describe("switch() runs the same ladder", () => {
    it("heals a stale profile instead of refusing it", async () => {
        // switch() had its own refresh copy that did not persist and treated an
        // outage as a dead profile. It delegates now, so this cannot drift.
        const { id, email } = disposable()
        const fresh = jwtExpiring(3600)

        await withStore(async store => {
            seed(store, id, email, jwtExpiring(30))
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.store.profiles.deactivate()

            const { stub } = backend({ refresh: "ok", freshToken: fresh })
            await withFetch(stub, async () => {
                await platform.cloud.switch(email)
            })

            expect(platform.store.profiles.current()?.id).toBe(email)
            expect(platform.store.profiles.get(email).record.get()?.auth.accessToken).toBe(fresh)
        })
    })

    it("reports an unreachable backend as its own failure, not as a dead profile", async () => {
        // Distinct errors because they need distinct handling: the auth page
        // offers a retry for one and a device flow for the other.
        const { id, email } = disposable()

        await withStore(async store => {
            seed(store, id, email, jwtExpiring(3600))
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store })
            platform.store.profiles.deactivate()

            const offline: typeof fetch = stubFetch(async () => { throw new TypeError("fetch failed") })
            await withFetch(offline, async () => {
                // Matched on the CODE, not the message: the code is the
                // contract the auth page branches on (retry vs device flow),
                // and prose is free to change.
                await expect(platform.cloud.switch(email)).rejects.toMatchObject({ code: "AX-TUI-044" })
            })

            // Preserved — the user retries, they do not re-authenticate.
            expect(platform.store.profiles.get(email).record.get()?.auth.accessToken).toBeDefined()
        })
    })
})
