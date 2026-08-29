/**
 * Bun preload — runs once per worker before any test file.
 *
 * Ensures the local staging daemon is running (db + backend), booting it if
 * this is a cold machine/CI run. Safe to call from multiple workers/packages
 * concurrently — Daemon.connect() is idempotent and race-safe.
 *
 * Tests never mock the backend — every AxonCloud() constructed in this
 * package's tests points baseUrl at this real, locally-running staging
 * instance (db + backend), not production.
 */
import { Repo } from "@arclabs/repo"

const repo = Repo()
const { backendUrl, dbUrl } = await repo.daemon.connect()

process.env.AXON_API_BASE = backendUrl
process.env.DATABASE_URL = dbUrl

// NOTE: deleting AXON_API_KEY / AXON_CONNECT_TOKEN here would NOT make the
// suite credential-free — preloads do not run in `--parallel` workers, so the
// deletion applies to a serial run and silently vanishes in the parallel one
// `bun run test` actually uses. Tests that must be anonymous say so at the
// call site via `anonymousCloud()` in ./staging.ts. See its comment.

// Stripe test-mode secret key — same one the local staging backend runs
// against. Loaded directly from the backend's own env file rather than
// duplicated here, so tests that confirm SetupIntents (simulating what
// Stripe.js does client-side) talk to the same Stripe test account.
if (!process.env.STRIPE_SECRET_KEY) {
    const envFile = Bun.file(`${import.meta.dir}/../../../../apps/backend/.env.local`)
    if (await envFile.exists()) {
        const match = (await envFile.text()).match(/^STRIPE_SECRET_KEY=(.+)$/m)
        if (match) process.env.STRIPE_SECRET_KEY = match[1].trim()
    }
}

/**
 * Deployment tests spend TEST_USER's real balance on real billing
 * commitments (deploy.test.ts, lifecycle.test.ts, etc.) — with nothing
 * refilling it, repeated runs eventually hit InsufficientFundsError. Top
 * up via the real Stripe test-mode charge flow (same pm_card_visa token
 * used in tests/billing/topup.test.ts) whenever the balance drops below a
 * floor, so the suite is self-sustaining run over run.
 */
const TOPUP_FLOOR_MINOR = 2_000_00
const TOPUP_AMOUNT_MINOR = 5_000_00

async function ensureFunded(): Promise<void> {
    const { AxonCloud } = await import("../../src")
    const cloud = AxonCloud({ baseUrl: process.env.AXON_API_BASE!, key: (await import("./user")).TEST_USER.apiKey })

    const balance = await cloud.user.billing.balance()
    if (balance.availableMinor >= TOPUP_FLOOR_MINOR) return

    const { clientSecret } = await cloud.user.billing.cards.add()
    const setupIntentId = clientSecret.split("_secret_")[0]
    const confirmRes = await fetch(`https://api.stripe.com/v1/setup_intents/${setupIntentId}/confirm`, {
        method: "POST",
        headers: {
            authorization: `Basic ${Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ payment_method: "pm_card_visa", client_secret: clientSecret }),
    })
    const confirmed = (await confirmRes.json()) as { status?: string; payment_method?: string }
    if (confirmed.status !== "succeeded" || typeof confirmed.payment_method !== "string") {
        throw new Error(`preload: failed to confirm test setup intent for funding top-up: ${JSON.stringify(confirmed)}`)
    }

    await cloud.user.billing.cards.sync()
    await cloud.user.billing.topup.charge({ amountMinor: TOPUP_AMOUNT_MINOR })
    await cloud.user.billing.cards.remove(confirmed.payment_method).catch(() => { /* best-effort */ })
}

await ensureFunded()
