import { AxonCloud } from "../../src"
import { TEST_USER, OTHER_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("deployment isolation", () => {
    it("a non-owner can't read another user's deployment status", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await owner.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            const asIntruder = intruder.registry.agents.agent("irrelevant").deployment(deployment.id)
            await expect(asIntruder.status()).rejects.toThrow()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("a non-owner can't start/stop/redeploy/delete another user's deployment", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await owner.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            const asIntruder = intruder.registry.agents.agent("irrelevant").deployment(deployment.id)

            await expect(asIntruder.stop()).rejects.toThrow()
            await expect(asIntruder.start()).rejects.toThrow()
            await expect(asIntruder.redeploy()).rejects.toThrow()
            await expect(asIntruder.delete()).rejects.toThrow()

            const status = await deployment.status()
            expect(status.status).toBe("running")

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("a non-owner can't read or write another user's deployment secrets", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await owner.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            const asIntruder = intruder.registry.agents.agent("irrelevant").deployment(deployment.id)

            await expect(asIntruder.secrets.set({ TEST_SECRET: "stolen" })).rejects.toThrow()
            await expect(asIntruder.secrets.delete("TEST_SECRET")).rejects.toThrow()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("a non-owner can't publish a new version to another user's agent", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })
        const second = await fixtureBundle({ version: "0.0.2" })

        try {
            const { agent, deployment } = await owner.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            const asIntruder = intruder.registry.artifacts.artifact(agent.id)
            await expect(asIntruder.publish({ path: second.path })).rejects.toThrow()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
            await second.cleanup()
        }
    }, 20_000)

    it("listOwned/list only ever surfaces the caller's own deployments and agents", async () => {
        const owner = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const intruder = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })
        const name = scopedName()

        try {
            const { agent, deployment } = await owner.registry.agents.deploy({ name, path: bundle.path, tier: "small" })

            const intruderAgents = await intruder.registry.artifacts.of("agent").listOwned()
            expect(intruderAgents.find(a => a.artifactId === agent.id)).toBeUndefined()

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)
})
