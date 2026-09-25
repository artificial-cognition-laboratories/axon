import { AxonCloud } from "../../../src"
import { withIdentity } from "../setup/identity"
import { stripeSecretKey } from "../setup/staging"


/**
 * Confirms a SetupIntent with Stripe's universal test card token
 * (pm_card_visa — a permanent Stripe test fixture, not a real card),
 * standing in for what Stripe.js/Elements does client-side in a browser.
 */
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

/**
 * Attaches a disposable test card and guarantees cleanup even if the test
 * body throws. Mirrors the real flow: add() -> confirm client-side -> sync()
 * to reconcile the default — list() itself never does this anymore.
 */
async function withTestCard(cloud: ReturnType<typeof AxonCloud>, fn: (paymentMethodId: string) => Promise<void>) {
    const { clientSecret } = await cloud.user.billing.cards.add()
    const { paymentMethodId } = await confirmWithTestCard(clientSecret)
    await cloud.user.billing.cards.sync()
    try {
        await fn(paymentMethodId)
    } finally {
        await cloud.user.billing.cards.remove(paymentMethodId)
    }
}

describe("billing.cards", () => {
    it("add() returns a real Stripe setup-intent client secret", async () => {
        await withIdentity("cards-add", async ({ cloud }) => {
            const result = await cloud.user.billing.cards.add()

            expect(result.clientSecret).toContain("_secret_")
        })
    })

    it("a confirmed setup intent shows up in list() with the real card details", async () => {
        await withIdentity("cards-list", async ({ cloud }) => {
            await withTestCard(cloud, async (paymentMethodId) => {
                const cards = await cloud.user.billing.cards.list()
                const found = cards.find(c => c.id === paymentMethodId)

                expect(found).toBeDefined()
                expect(found!.brand).toBe("visa")
                expect(found!.last4).toBe("4242")
            })
        })
    })

    it("the first card added is automatically made the default", async () => {
        await withIdentity("cards-default", async ({ cloud }) => {
            await withTestCard(cloud, async (paymentMethodId) => {
                const cards = await cloud.user.billing.cards.list()
                const found = cards.find(c => c.id === paymentMethodId)

                expect(found?.isDefault).toBe(true)
            })
        })
    })

    it("setDefault() changes which card is marked default among two", async () => {
        await withIdentity("cards-set-default", async ({ cloud }) => {
            await withTestCard(cloud, async (first) => {
                await withTestCard(cloud, async (second) => {
                    await cloud.user.billing.cards.setDefault(second)

                    const cards = await cloud.user.billing.cards.list()
                    expect(cards.find(c => c.id === second)?.isDefault).toBe(true)
                    expect(cards.find(c => c.id === first)?.isDefault).toBe(false)
                })
            })
        })
    })

    it("list() is a pure read — never auto-defaults a card on its own without sync()", async () => {
        await withIdentity("cards-pure-list", async ({ cloud }) => {
            const { clientSecret } = await cloud.user.billing.cards.add()
            const { paymentMethodId } = await confirmWithTestCard(clientSecret)

            try {
                // list() alone, no sync() — Stripe has no default set yet, so
                // isDefault must reflect that rather than being force-true
                const cards = await cloud.user.billing.cards.list()
                const found = cards.find(c => c.id === paymentMethodId)

                expect(found).toBeDefined()
                expect(found?.isDefault).toBe(false)
            } finally {
                await cloud.user.billing.cards.remove(paymentMethodId)
            }
        })
    })

    it("remove() detaches the card — it no longer appears in list()", async () => {
        await withIdentity("cards-remove", async ({ cloud }) => {
            const { clientSecret } = await cloud.user.billing.cards.add()
            const { paymentMethodId } = await confirmWithTestCard(clientSecret)

            await cloud.user.billing.cards.remove(paymentMethodId)

            const cards = await cloud.user.billing.cards.list()
            expect(cards.some(c => c.id === paymentMethodId)).toBe(false)
        })
    })
})
