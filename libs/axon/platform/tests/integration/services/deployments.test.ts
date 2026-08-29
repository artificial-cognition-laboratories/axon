import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * The user's deployed agents, cached.
 *
 * Cached deliberately: the local agent list is a synchronous disk read, so a
 * palette that awaited a network call to open would block on it. `list()`
 * serves whatever was last fetched and `refresh()` is the only thing that
 * touches the network.
 *
 * The property that matters is that a failure NEVER crashes the caller — the
 * local agent list must still work when logged out or offline — while still
 * being visible on `error` rather than silently listing nothing.
 */

async function authenticatedPlatform(storeDir: string) {
    const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
    return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
}

describe("services.deployments", () => {
    it("is empty before the first refresh — construction touches no network", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        try {
            const platform = await authenticatedPlatform(storeDir)

            expect(platform.deployments.list()).toEqual([])
            expect(platform.deployments.error).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("refreshes against the real control plane and caches the result", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        try {
            const platform = await authenticatedPlatform(storeDir)

            const fetched = await platform.deployments.refresh()

            expect(Array.isArray(fetched)).toBe(true)
            expect(platform.deployments.error).toBeNull()
            // list() serves the cache the refresh just filled.
            expect(platform.deployments.list()).toEqual(fetched)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("records a failure on `error` instead of throwing — the local agent list must still work", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        try {
            // No profile saved: the client has no credential to present.
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })

            const fetched = await platform.deployments.refresh()

            expect(fetched).toEqual([])
            expect(platform.deployments.error).toBeInstanceOf(Error)
            // Still usable — a failed refresh degrades to an empty list, and the
            // reason is readable rather than swallowed.
            expect(platform.deployments.list()).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("clears a previous error once a refresh succeeds", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await platform.deployments.refresh()
            expect(platform.deployments.error).toBeInstanceOf(Error)

            platform.store.profiles.save(TEST_USER.id, {
                user: { id: TEST_USER.id, email: TEST_USER.email },
                auth: { apiKey: TEST_USER.apiKey },
            })
            const authenticated = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await authenticated.deployments.refresh()

            expect(authenticated.deployments.error).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    }, 30_000)

    it("finds nothing by name when nothing has been fetched", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        try {
            const platform = await authenticatedPlatform(storeDir)

            expect(platform.deployments.find("@someone/not-deployed")).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
