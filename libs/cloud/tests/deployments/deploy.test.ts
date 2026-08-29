import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("agents.deploy", () => {
    it("registers, publishes, provisions, and waits until a real agent is running", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { agent, deployment, url } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
            })

            expect(url.startsWith("http://localhost:")).toBe(true)

            const status = await deployment.status()
            expect(status.status).toBe("running")
            expect(status.url).toBe(url)

            const record = await agent.get()
            expect(record.artifactId).toBe(agent.id)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("the deployed process is real — a real HTTP request reaches the fixture agent's own route", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment, url } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
            })

            const response = await fetch(`${url}/api/ping`)
            const body = await response.json()

            expect(body).toEqual({ pong: true })

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("reports progress through each step in order", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })
        const steps: string[] = []

        try {
            const { deployment } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
                onProgress: step => steps.push(step.step),
            })

            expect(steps).toEqual(["publishing", "provisioning", "starting", "ready"])

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("calling deploy() twice for the same name replaces the revision in one stable deployment slot", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName()
        const first = await fixtureBundle({ version: "0.0.1" })
        const second = await fixtureBundle({ version: "0.0.2" })

        try {
            const firstDeploy = await cloud.registry.agents.deploy({ name, path: first.path, tier: "small" })
            const secondDeploy = await cloud.registry.agents.deploy({ name, path: second.path, tier: "small" })

            expect(secondDeploy.agent.id).toBe(firstDeploy.agent.id)
            expect(secondDeploy.deployment.id).toBe(firstDeploy.deployment.id)
            expect(secondDeploy.url).toBe(firstDeploy.url)

            const commitments = await cloud.user.billing.commitments.list()
            expect(commitments.filter(commitment => commitment.deploymentId === firstDeploy.deployment.id)).toHaveLength(1)

            const entries = await cloud.user.billing.ledger.list({ limit: 100 })
            const charges = entries.filter(entry =>
                entry.referenceType === "deployment" && entry.referenceId === firstDeploy.deployment.id && entry.status === "posted",
            )
            expect(charges).toHaveLength(1)

            await secondDeploy.deployment.delete()
        } finally {
            await first.cleanup()
            await second.cleanup()
        }
    }, 20_000)
})
