import { AxonCloud } from "../../src"
import { OTHER_USER, TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("deployment logs", () => {
    it("returns captured runtime logs for an owned deployment and respects limit", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            const entries = await deployment.logs({ limit: 1 })

            expect(entries).toHaveLength(1)
            // The entrypoint's readiness line — see libs/axon/packages/docker/boot.ts.
            expect(entries[0]?.message).toContain("[boot:complete]")
            expect(entries[0]?.severity).toBe("INFO")
            expect(Number.isFinite(Date.parse(entries[0]?.timestamp ?? ""))).toBe(true)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("never exposes one user's deployment logs to another user", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const other = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await owner.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            await expect(other.registry.agents.agent("anything").deployment(deployment.id).logs()).rejects.toThrow()
            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)
})
