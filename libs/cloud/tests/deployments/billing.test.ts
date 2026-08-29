import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { withIdentity } from "../setup/identity"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


describe("deployment billing", () => {
    it("deploying creates a real commitment tied to the deployment", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            const commitments = await cloud.user.billing.commitments.list()
            const commitment = commitments.find(c => c.deploymentId === deployment.id)

            expect(commitment).toBeDefined()
            expect(commitment?.kind).toBe("deployment")
            expect(commitment?.status).toBe("active")
            expect(commitment?.autoRenew).toBe(true)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 35_000)

    it("deploying reserves and captures the quoted price — balance drops by exactly that amount", async () => {
        await withIdentity("deploy-billing", async ({ cloud, who }) => {
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const quote = await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })
            const before = await cloud.user.billing.balance()

            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName("billing", who), path: bundle.path, tier: "small" })
            const after = await cloud.user.billing.balance()

            // The balance delta is the honest way to state this — "deploying
            // takes exactly the quoted price out of the account" — and on an
            // identity nobody else is billing, it is finally safe to assert.
            // Against the shared TEST_USER this read a concurrent commitment
            // and failed with 9800 for a 4900 quote.
            expect(before.availableMinor - after.availableMinor).toBe(quote.amountMinor)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
        })
    }, 35_000)

    it("posts a real ledger entry referencing the deployment", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const quote = await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })
            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })

            const entries = await cloud.user.billing.ledger.list({ limit: 10 })
            const posted = entries.find(e => e.referenceType === "deployment" && e.referenceId === deployment.id)

            expect(posted).toBeDefined()
            expect(posted?.amountMinor).toBe(-quote.amountMinor)

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 35_000)

    it("delete() cancels the commitment's auto-renewal", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({ name: scopedName(), path: bundle.path, tier: "small" })
            await deployment.delete()

            const commitments = await cloud.user.billing.commitments.list()
            const commitment = commitments.find(c => c.deploymentId === deployment.id)

            expect(commitment?.autoRenew).toBe(false)
        } finally {
            await bundle.cleanup()
        }
    }, 35_000)
})
