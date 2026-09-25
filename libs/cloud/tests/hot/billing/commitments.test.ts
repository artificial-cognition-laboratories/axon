import { AxonCloud } from "../../../src"
import { TEST_USER } from "../../full/setup/user"
import { withIdentity } from "../../full/setup/identity"
import { backendUrl, anonymousCloud } from "../../full/setup/staging"

const baseUrl = backendUrl()

describe("billing.commitments.price", () => {
    it("requires auth", async () => {
        await expect(anonymousCloud().user.billing.commitments.price({ tier: "small", warmth: "on-demand" })).rejects.toThrow()
    })

    it("quotes a real monthly price for a given tier/warmth", async () => {
        const quote = await AxonCloud({ baseUrl, key: TEST_USER.apiKey }).user.billing.commitments.price({ tier: "small", warmth: "on-demand" })

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
            const after = await cloud.user.billing.balance()

            expect(after.availableMinor).toBe(before.availableMinor)
            expect(await cloud.user.billing.commitments.list()).toEqual([])
        })
    })
})

describe("billing.commitments.cancelRenewal / resumeRenewal", () => {
    it("requires auth", async () => {
        await expect(anonymousCloud().user.billing.commitments.cancelRenewal("nonexistent-id")).rejects.toThrow()
    })

    it("rejects an unknown commitment id", async () => {
        await expect(AxonCloud({ baseUrl, key: TEST_USER.apiKey }).user.billing.commitments.cancelRenewal(`nonexistent-${crypto.randomUUID()}`)).rejects.toThrow()
    })
})
