import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { OTHER_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * Signup welcome credit — the behaviour a new account sees, through the real
 * AxonCloud consumer surface against local staging.
 *
 * OTHER_USER is the seeded fresh identity: a real user with NO pre-funding and
 * no billing history. The grant fires at billing-account creation
 * (accounts.ensure), which every billing endpoint funnels through — so the
 * first billing call (here, ledger.list()) creates the account and lands the
 * welcome credit. This is path-independent: any billing access triggers it,
 * not one specific endpoint.
 *
 * The assertion is repeatable against a persistent staging DB: the account is
 * created once, so on a fresh DB the bonus is posted and on a re-run the
 * account already exists — either way there is exactly one signup_bonus entry.
 */
describe("signup welcome credit", () => {
    async function clientForOtherUser(storeDir: string) {
        const seed = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        seed.store.profiles.save(OTHER_USER.id, {
            user: { id: OTHER_USER.id, email: OTHER_USER.email },
            auth: { apiKey: OTHER_USER.apiKey },
        })
        return Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir }).cloud.client
    }

    it("a fresh account receives exactly one welcome credit when billing is first touched", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const client = await clientForOtherUser(storeDir)

            // First billing access creates the account and grants the credit.
            const ledger = await client.user.billing.ledger.list({ limit: 100 })
            const bonuses = ledger.filter(entry => entry.kind === "signup_bonus")

            expect(bonuses.length).toBe(1)
            expect(bonuses[0]!.amountMinor).toBe(25)
            expect(bonuses[0]!.status).toBe("posted")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("touching billing repeatedly does not grant a second credit", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const client = await clientForOtherUser(storeDir)

            // Repeated billing access must never accumulate bonuses — the
            // account already exists after the first, so no further grant.
            await client.user.billing.balance()
            await client.user.billing.ledger.list({ limit: 100 })
            const ledger = await client.user.billing.ledger.list({ limit: 100 })
            const bonuses = ledger.filter(entry => entry.kind === "signup_bonus")

            expect(bonuses.length).toBe(1)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
