import { anonymousCloud } from "../../full/setup/staging"

describe("billing authentication", () => {
    it("rejects unauthenticated card setup", async () => {
        await expect(anonymousCloud().user.billing.cards.add()).rejects.toThrow()
    })

    it("rejects unauthenticated card listing", async () => {
        await expect(anonymousCloud().user.billing.cards.list()).rejects.toThrow()
    })

    it("rejects unauthenticated card synchronisation", async () => {
        await expect(anonymousCloud().user.billing.cards.sync()).rejects.toThrow()
    })

    it("rejects unauthenticated top-ups", async () => {
        await expect(anonymousCloud().user.billing.topup.charge({ amountMinor: 500 })).rejects.toThrow()
    })

    it("rejects unauthenticated auto-top-up reads", async () => {
        await expect(anonymousCloud().user.billing.topup.auto.get()).rejects.toThrow()
    })

    it("rejects unauthenticated auto-top-up writes", async () => {
        await expect(anonymousCloud().user.billing.topup.auto.set({
            enabled: true, thresholdMinor: 100, topupAmountMinor: 100, maxTopupsPerDay: 1,
        })).rejects.toThrow()
    })

    it("rejects unauthenticated billing-portal access", async () => {
        await expect(anonymousCloud().user.billing.portal()).rejects.toThrow()
    })
})
