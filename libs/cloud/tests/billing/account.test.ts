import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("billing.account", () => {
    it("requires auth — no key rejects rather than returning an anonymous/default account", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.account()).rejects.toThrow()
    })

    it("returns the real seeded account for TEST_USER", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const account = await cloud.user.billing.account()

        expect(account.ownerId).toBe(TEST_USER.id)
        expect(account.ownerType).toBe("user")
        expect(account.status).toBe("active")
    })

    it("account has a currency and a stable id across repeated calls", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const first = await cloud.user.billing.account()
        const second = await cloud.user.billing.account()

        expect(first.id).toBe(second.id)
        expect(typeof first.currency).toBe("string")
        expect(first.currency.length).toBe(3)
    })
})

describe("billing.balance", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.balance()).rejects.toThrow()
    })

    it("returns real numeric fields for TEST_USER's pre-funded account", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const balance = await cloud.user.billing.balance()

        expect(typeof balance.postedMinor).toBe("number")
        expect(typeof balance.reservedMinor).toBe("number")
        expect(typeof balance.availableMinor).toBe("number")
        expect(balance.currency).toBe("gbp")
    })

    it("availableMinor is always postedMinor + reservedMinor — the core balance invariant", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const balance = await cloud.user.billing.balance()

        expect(balance.availableMinor).toBe(balance.postedMinor + balance.reservedMinor)
    })

    it("reservedMinor is never positive — it represents funds held back, not added", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const balance = await cloud.user.billing.balance()

        expect(balance.reservedMinor).toBeLessThanOrEqual(0)
    })

    it("TEST_USER genuinely has a positive available balance from the seed's pre-funding", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const balance = await cloud.user.billing.balance()

        expect(balance.availableMinor).toBeGreaterThan(0)
    })
})

describe("billing.portal", () => {
    it("returns a real Stripe-hosted portal URL", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const portal = await cloud.user.billing.portal()

        expect(portal.url).toContain("http")
    })

    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.portal()).rejects.toThrow()
    })
})
