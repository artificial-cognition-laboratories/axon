import { AxonCloud } from "../../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "../deployments/fixtures"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("billing.commitments.list", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.commitments.list()).rejects.toThrow()
    })

    it("returns the caller's real commitments with the expected shape", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const commitments = await cloud.user.billing.commitments.list()

        expect(commitments.length).toBeGreaterThan(0)
        const first = commitments[0]
        expect(typeof first.id).toBe("string")
        expect(first.kind).toBe("deployment")
        expect(typeof first.amountMinor).toBe("number")
        expect(first.currency).toBe("gbp")
        expect(typeof first.autoRenew).toBe("boolean")
    })
})

describe("billing.commitments.cancelRenewal / resumeRenewal", () => {
    it("toggles autoRenew on a real commitment", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        // Deploys its own agent rather than scavenging an existing commitment
        // off TEST_USER. The scavenging version passed only because previous
        // runs had leaked deployments into the shared account — once the
        // fixture sweep actually started working, there was nothing left to
        // find and this failed with "none found". A test that needs a
        // commitment creates a commitment; deploy() provisions one.
        const { deployment } = await cloud.registry.agents.deploy({
            name: scopedName(),
            path: bundle.path,
            tier: "small",
        })

        try {
            const commitmentFor = async () =>
                (await cloud.user.billing.commitments.list()).find(c => c.deploymentId === deployment.id)

            const created = await commitmentFor()
            expect(created?.status).toBe("active")
            expect(created?.autoRenew).toBe(true)

            await cloud.user.billing.commitments.cancelRenewal(created!.id)
            expect((await commitmentFor())?.autoRenew).toBe(false)

            await cloud.user.billing.commitments.resumeRenewal(created!.id)
            expect((await commitmentFor())?.autoRenew).toBe(true)
        } finally {
            // No autoRenew restore needed — the whole deployment goes, and its
            // commitment with it, so there is no shared state left to repair.
            await deployment.delete().catch(() => {})
            await bundle.cleanup()
        }
    }, 45_000)
})
