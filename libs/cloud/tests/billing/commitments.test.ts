import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { withIdentity } from "../setup/identity"
import { fixtureBundle } from "../deployments/fixtures"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("billing.commitments.price", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })).rejects.toThrow()
    })

    it("quotes a real monthly price for a given tier/warmth", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const quote = await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })

        expect(quote.kind).toBe("deployment")
        expect(quote.currency).toBe("gbp")
        expect(quote.amountMinor).toBeGreaterThan(0)
        expect(quote.periodDays).toBeGreaterThan(0)
        expect(quote.tier).toBe("small")
        expect(quote.warmth).toBe("on-demand")
    })

    it("a bigger tier quotes a higher (or equal) price than a smaller one", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const small = await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })
        const large = await cloud.user.billing.commitments.price({ tier: "large", warmth: "on-demand" })

        expect(large.amountMinor).toBeGreaterThanOrEqual(small.amountMinor)
    })

    it("is a pure quote — repeated calls don't create commitments or move money", async () => {
        await withIdentity("price-purity", async ({ cloud }) => {
            const before = await cloud.user.billing.balance()

            await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })
            await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })

            // On an identity nobody else is billing, "moved no money" can be
            // stated directly: the balance and the ledger are both untouched.
            // Against the shared TEST_USER neither was assertable, because a
            // concurrent charge from another test would fail this while
            // price() was behaving perfectly.
            const after = await cloud.user.billing.balance()
            expect(after.availableMinor).toBe(before.availableMinor)
            expect(await cloud.user.billing.commitments.list()).toEqual([])
        })
    })
})

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
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.commitments.cancelRenewal("nonexistent-id")).rejects.toThrow()
    })

    it("rejects an unknown commitment id", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.user.billing.commitments.cancelRenewal(`nonexistent-${crypto.randomUUID()}`)).rejects.toThrow()
    })

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
