import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()


async function readEnv(url: string): Promise<string | null> {
    const response = await fetch(`${url}/api/env`)
    const body = (await response.json()) as { value: string | null }
    return body.value
}

/**
 * Read until the env var reaches `expected`, or give up.
 *
 * waitUntilReady() resolves when the NEW revision is serving, which is not the
 * same as the old one having stopped: for a short window either process can
 * answer, so a single read can legitimately see the pre-respawn value. Under
 * an idle suite the race almost never lands; under the full 321-test run it
 * did, which is exactly the shape of a flake worth removing rather than
 * re-running.
 *
 * Polls rather than sleeping a fixed amount — a correct deployment satisfies
 * this on the first attempt and costs nothing.
 *
 * 60s rather than 30s because these suites now run inside `arc ship fleet`,
 * immediately after platform's 737 tests, with --parallel=4 spawning four real
 * `bun run` subprocesses at once. At a load average of ~6 a respawn that takes
 * 8s idle can exceed 30s — it failed here as "the deployment did not respawn"
 * while passing every time this file ran alone. The budget is not the
 * assertion: a respawn that never happens still fails, just after waiting long
 * enough to be sure it never will.
 */
async function readEnvUntil(url: string, expected: string | null, timeoutMs = 60_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    let last: string | null = null
    let reachable = false

    while (Date.now() < deadline) {
        // A connection error is NOT the same as "the variable is unset". While
        // the process respawns it refuses connections, and folding that into
        // null made "not up yet" indistinguishable from "absent" — so a poll
        // that spent its whole budget unreachable returned null and looked
        // like a passing assertion for expected === null, or a value mismatch
        // for anything else. Track reachability separately and say so.
        try {
            last = await readEnv(url)
            reachable = true
            if (last === expected) return last
        } catch {
            // still respawning — keep waiting rather than recording a reading
        }
        await Bun.sleep(500)
    }

    if (!reachable) {
        throw new Error(`${url} never became reachable within ${timeoutMs}ms — the deployment did not respawn, so nothing about its env was observed`)
    }
    return last
}

describe("deployment secrets", () => {
    it("deploy() injects production env before the first process boots", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
                env: { TEST_SECRET: "from-production-env" },
            })

            expect(await readEnv(url)).toBe("from-production-env")
            // The user's secret is present alongside the platform's own injected
            // credentials (AXON_API_KEY et al) — an exact-list assertion here
            // would break every time managed identity gains a field.
            expect(await deployment.secrets.list()).toContain("TEST_SECRET")
            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 30_000)

    it("set() writes an env var the running process actually reads, after a respawn", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            expect(await readEnv(url)).toBeNull()

            await deployment.secrets.set({ TEST_SECRET: "hunter2" })
            await deployment.waitUntilReady({ timeoutMs: 60_000 })

            expect(await readEnvUntil(url, "hunter2")).toBe("hunter2")

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
        // Outer budget must exceed the sum of the inner waits it contains
        // (waitUntilReady + readEnvUntil), or Bun kills the test before either
        // can report WHY it gave up — turning a legible "did not respawn" into
        // a bare timeout. Kept at 2x the inner budget for that reason.
    }, 150_000)

    it("the deployment URL stays stable across the secret-set respawn", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            await deployment.secrets.set({ TEST_SECRET: "value-1" })
            const status = await deployment.waitUntilReady({ timeoutMs: 60_000 })

            expect(status.url).toBe(url)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 90_000)

    it("delete(key) removes the secret and the respawned process no longer sees it", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            await deployment.secrets.set({ TEST_SECRET: "hunter2" })
            await deployment.waitUntilReady({ timeoutMs: 60_000 })
            expect(await readEnvUntil(url, "hunter2")).toBe("hunter2")

            await deployment.secrets.delete("TEST_SECRET")
            await deployment.waitUntilReady({ timeoutMs: 60_000 })

            expect(await readEnvUntil(url, null)).toBeNull()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
        // Two respawns, so four inner waits — the widest budget in the file.
    }, 300_000)

    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.registry.agents.agent("anything").deployment("anything").secrets.set({ A: "b" })).rejects.toThrow()
    })
})
