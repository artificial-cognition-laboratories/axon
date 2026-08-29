import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("deployment lifecycle", () => {
    it("stop() actually kills the process — status flips and the URL stops responding", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            await deployment.stop()
            const status = await deployment.status()
            expect(status.status).toBe("stopped")

            await expect(fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 90_000)

    it("start() brings a stopped deployment back and it's reachable again", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            await deployment.stop()

            await deployment.start()
            const { url } = await deployment.waitUntilReady({ timeoutMs: 60_000 })
            const response = await fetch(`${url}/api/ping`)

            expect(await response.json()).toEqual({ pong: true })

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
        // A deploy plus a full respawn. The outer budget has to clear the inner
        // waitUntilReady, or Bun kills the test before it can say what failed.
    }, 120_000)

    it("redeploy() picks up a newly published version on the same deployment", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName()
        const first = await fixtureBundle({ version: "0.0.1" })
        const second = await fixtureBundle({ version: "0.0.2" })

        try {
            const { agent, deployment, url: firstUrl } = await cloud.registry.agents.deploy({ name, path: first.path, tier: "small" })
            await agent.publish({ path: second.path })

            await deployment.redeploy()
            const status = await deployment.status()

            expect(status.status).toBe("running")
            expect(status.url).toBe(firstUrl)

            const versions = await agent.versions()
            expect(versions.find(v => v.version === "0.0.2")).toBeDefined()

            await deployment.delete()
        } finally {
            await first.cleanup()
            await second.cleanup()
        }
    }, 90_000)

    it("delete() tears down the process and stops the billing commitment from renewing", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            await deployment.delete()

            const status = await deployment.status()
            expect(status.status).toBe("stopped")
            await expect(fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
        } finally {
            await bundle.cleanup()
        }
    }, 90_000)
})
