import { AxonCloud, InsufficientFundsError } from "../../src"
import { OTHER_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()


// OTHER_USER is never topped up (see tests/setup/preload.ts) — a stable,
// permanently zero-balance identity for exercising the insufficient-funds path.
describe("deploy: insufficient funds", () => {
    it("rejects with InsufficientFundsError rather than a generic HTTP error", async () => {
        const cloud = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            await expect(
                cloud.registry.agents.deploy({ name: scopedName("test-fixture-agent", OTHER_USER), path: bundle.path, tier: "small" }),
            ).rejects.toThrow(InsufficientFundsError)
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("carries the real deficit, available, and required amounts", async () => {
        const cloud = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const quote = await cloud.user.billing.commitments.price({ tier: "small", warmth: "on-demand" })

            try {
                await cloud.registry.agents.deploy({ name: scopedName("test-fixture-agent", OTHER_USER), path: bundle.path, tier: "small" })
                throw new Error("expected deploy() to reject")
            } catch (err) {
                expect(err).toBeInstanceOf(InsufficientFundsError)
                const insufficientFundsError = err as InsufficientFundsError
                // Every account starts with a signup bonus, so `available` is
                // never 0 for a real user. The invariant that matters is the
                // arithmetic: the deficit is exactly what the commitment costs
                // minus whatever the account actually holds.
                expect(insufficientFundsError.requiredMinor).toBe(quote.amountMinor)
                expect(insufficientFundsError.availableMinor).toBeLessThan(quote.amountMinor)
                expect(insufficientFundsError.deficitMinor).toBe(
                    quote.amountMinor - insufficientFundsError.availableMinor,
                )
            }
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("carries a real Stripe checkout URL to resolve the deficit", async () => {
        const cloud = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            try {
                await cloud.registry.agents.deploy({ name: scopedName("test-fixture-agent", OTHER_USER), path: bundle.path, tier: "small" })
                throw new Error("expected deploy() to reject")
            } catch (err) {
                expect(err).toBeInstanceOf(InsufficientFundsError)
                expect((err as InsufficientFundsError).checkoutUrl).toContain("checkout.stripe.com")
            }
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)

    it("leaves no active commitment behind after rejecting", async () => {
        const cloud = AxonCloud({ baseUrl, key: OTHER_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })
        const name = scopedName()

        try {
            await expect(cloud.registry.agents.deploy({ name, path: bundle.path, tier: "small" })).rejects.toThrow()

            const commitments = await cloud.user.billing.commitments.list()
            expect(commitments.filter(c => c.status === "active").length).toBe(0)
        } finally {
            await bundle.cleanup()
        }
    }, 20_000)
})
