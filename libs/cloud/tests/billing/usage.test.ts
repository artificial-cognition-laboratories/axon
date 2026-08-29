import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"
import { withIdentity } from "../setup/identity"

const baseUrl = backendUrl()

describe("billing.usage.summary", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.usage.summary()).rejects.toThrow()
    })

    it("returns a summary with the expected shape", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const summary = await cloud.user.billing.usage.summary()

        expect(typeof summary.totalMinor).toBe("number")
        expect(summary.currency).toBe("gbp")
        expect(Array.isArray(summary.items)).toBe(true)
    })

    it("each item has a date, amount, and kind", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const summary = await cloud.user.billing.usage.summary()

        expect(summary.items.length).toBeGreaterThan(0)
        const first = summary.items[0]
        expect(typeof first.date).toBe("string")
        expect(typeof first.amountMinor).toBe("number")
        expect(typeof first.kind).toBe("string")
    })

    it("totalMinor equals the sum of item amounts", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const summary = await cloud.user.billing.usage.summary()

        const sum = summary.items.reduce((acc, item) => acc + item.amountMinor, 0)
        expect(summary.totalMinor).toBe(sum)
    })

    it("a narrower window (days) never has a larger magnitude of total spend than a wider one", async () => {
        // Isolated: the two summaries are separate reads of a live account, so
        // against the shared TEST_USER a charge landing between them could make
        // the 1-day window legitimately exceed the 365-day one and fail a
        // property that is actually true.
        await withIdentity("usage-window", async ({ cloud }) => {
            const narrow = await cloud.user.billing.usage.summary({ days: 1 })
            const wide = await cloud.user.billing.usage.summary({ days: 365 })

            expect(Math.abs(narrow.totalMinor)).toBeLessThanOrEqual(Math.abs(wide.totalMinor))
        })
    })

    it("an unreasonably narrow window (0 days ago) still resolves without throwing", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await expect(cloud.user.billing.usage.summary({ days: 0 })).resolves.toBeDefined()
    })
})
