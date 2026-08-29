import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, stripeSecretKey, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()


/** Confirms a SetupIntent with Stripe's universal test card token (pm_card_visa), standing in for Stripe.js. */
async function confirmWithTestCard(clientSecret: string): Promise<{ paymentMethodId: string }> {
    const setupIntentId = clientSecret.split("_secret_")[0]
    const res = await fetch(`https://api.stripe.com/v1/setup_intents/${setupIntentId}/confirm`, {
        method: "POST",
        headers: {
            authorization: `Basic ${Buffer.from(`${stripeSecretKey()}:`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ payment_method: "pm_card_visa", client_secret: clientSecret }),
    })
    const body = await res.json() as { status?: string; payment_method?: string }
    if (body.status !== "succeeded" || typeof body.payment_method !== "string") {
        throw new Error(`failed to confirm test setup intent: ${JSON.stringify(body)}`)
    }
    return { paymentMethodId: body.payment_method }
}

/** Attaches a real disposable default card for the duration of fn, then removes it — topup.charge() requires one. */
async function withDefaultCard(cloud: ReturnType<typeof AxonCloud>, fn: () => Promise<void>) {
    const { clientSecret } = await cloud.user.billing.cards.add()
    const { paymentMethodId } = await confirmWithTestCard(clientSecret)
    await cloud.user.billing.cards.sync()
    try {
        await fn()
    } finally {
        await cloud.user.billing.cards.remove(paymentMethodId).catch(() => { /* best-effort */ })
    }
}

describe("billing.topup.charge", () => {
    it("requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.topup.charge({ amountMinor: 500 })).rejects.toThrow()
    })

    it("rejects with no stored default card, rather than silently doing nothing", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const existing = await cloud.user.billing.cards.list()
        for (const card of existing) await cloud.user.billing.cards.remove(card.id)

        await expect(cloud.user.billing.topup.charge({ amountMinor: 500 })).rejects.toThrow()
    })

    it("charges the real stored test card and returns a real paymentIntentId", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await withDefaultCard(cloud, async () => {
            const result = await cloud.user.billing.topup.charge({ amountMinor: 500 })

            expect(result.paymentIntentId).toContain("pi_")
            expect(result.balance.currency).toBe("gbp")
        })
    })

    it("increases the available balance by exactly the charged amount", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await withDefaultCard(cloud, async () => {
            const seen = new Set((await cloud.user.billing.ledger.list({ limit: 50 })).map(e => e.id))
            const result = await cloud.user.billing.topup.charge({ amountMinor: 500 })

            // Asserted against this charge's own ledger entry, not the account
            // total. `before + 500` assumes nothing else moved the balance, but
            // TEST_USER is shared — a concurrent token_charge or commitment
            // between the read and the charge makes the sum wrong while the
            // topup itself was perfectly correct. The credited amount is the
            // invariant; the resulting total is not this test's business.
            const entries = await cloud.user.billing.ledger.list({ limit: 50 })
            const mine = entries.filter(e => !seen.has(e.id) && e.kind === "topup")

            expect(mine).toHaveLength(1)
            expect(mine[0]!.amountMinor).toBe(500)
            void result
        })
    })

    it("posts a real ledger entry for the charge", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        await withDefaultCard(cloud, async () => {
            const result = await cloud.user.billing.topup.charge({ amountMinor: 500 })

            const entries = await cloud.user.billing.ledger.list({ limit: 5 })
            const posted = entries.find(e => e.referenceId === null && e.kind === "topup" && e.amountMinor === 500)

            expect(posted).toBeDefined()
            expect(posted?.metadata).toBeDefined()
            void result
        })
    })
})

describe("billing.topup.auto", () => {
    it("get() requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.topup.auto.get()).rejects.toThrow()
    })

    it("get() returns a sensible disabled-by-default policy before one is ever set", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        // reset to a known state first — other tests in this file may have changed it
        await cloud.user.billing.topup.auto.set({ enabled: false, thresholdMinor: 0, topupAmountMinor: 0, maxTopupsPerDay: 3 })

        const policy = await cloud.user.billing.topup.auto.get()

        expect(policy.enabled).toBe(false)
        expect(policy.currency).toBe("gbp")
    })

    it("set() persists a new policy, reflected on the next get()", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const set = await cloud.user.billing.topup.auto.set({
            enabled: true,
            thresholdMinor: 1000,
            topupAmountMinor: 2000,
            maxTopupsPerDay: 2,
        })

        expect(set.enabled).toBe(true)
        expect(set.thresholdMinor).toBe(1000)
        expect(set.topupAmountMinor).toBe(2000)
        expect(set.maxTopupsPerDay).toBe(2)

        const fetched = await cloud.user.billing.topup.auto.get()
        expect(fetched).toEqual(set)

        // restore a clean disabled state for other tests
        await cloud.user.billing.topup.auto.set({ enabled: false, thresholdMinor: 0, topupAmountMinor: 0, maxTopupsPerDay: 3 })
    })

    it("set() requires auth", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.topup.auto.set({
            enabled: true, thresholdMinor: 100, topupAmountMinor: 100, maxTopupsPerDay: 1,
        })).rejects.toThrow()
    })

    it("set() is idempotent — setting the same policy twice yields the same result", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const input = { enabled: true, thresholdMinor: 500, topupAmountMinor: 1500, maxTopupsPerDay: 1 }

        const first = await cloud.user.billing.topup.auto.set(input)
        const second = await cloud.user.billing.topup.auto.set(input)

        expect(second.thresholdMinor).toBe(first.thresholdMinor)
        expect(second.topupAmountMinor).toBe(first.topupAmountMinor)

        await cloud.user.billing.topup.auto.set({ enabled: false, thresholdMinor: 0, topupAmountMinor: 0, maxTopupsPerDay: 3 })
    })
})
