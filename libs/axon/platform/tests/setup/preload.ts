/**
 * Bun preload — runs once per worker before any test file.
 *
 * Ensures the local staging daemon is running (db + backend), booting it if
 * this is a cold machine/CI run. Safe to call from multiple workers/packages
 * concurrently — Daemon.connect() is idempotent and race-safe.
 *
 * Tests never mock the backend. Setting AXON_STAGING_MODE=true here makes every
 * AxonCloud() constructed with no explicit baseUrl — including the TUI's
 * Platform().cloud — default to http://localhost:3099 (libs/cloud's
 * Http() reads this same flag the backend itself uses to swap its own
 * storage/deployments backends), so no test needs to configure this itself.
 */
import { Repo } from "@arclabs/repo"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"


/**
 * libs/axon/tui/.env sets AXON_API_KEY for local dev convenience (so a
 * bare `axon` CLI invocation authenticates without a stored profile) —
 * Bun auto-loads it, and libs/cloud's Auth() falls back to it whenever no
 * explicit key/session is passed. Left alone, that silently authenticates
 * every "unauthenticated Platform()" test as whoever that key belongs to.
 * Tests must control their own auth state entirely through Platform()'s
 * store, never an ambient env fallback.
 */
delete process.env.AXON_API_KEY
delete process.env.AXON_CONNECT_TOKEN

process.env.AXON_STAGING_MODE = "true"

/**
 * Project.deploy() spawns a real local Cloud Run stand-in subprocess (see
 * libs/cloud's MockDeployments). A client-side timeout doesn't guarantee
 * the server-side provision() actually stopped — sweep any stray boot.ts
 * processes from a previous run before starting, so every run begins from
 * a clean slate rather than accumulating orphans.
 */
/**
 * Bun evaluates preloads in each worker, including workers it starts later in
 * a parallel run. The stale-process sweep must therefore run once per test
 * RUNNER, not once per worker: a late worker otherwise kills a live mock
 * deployment or cognet compiler owned by an earlier worker.
 *
 * The lock has to identify the runner, and `process.ppid` does not. Sibling
 * workers spawned by the same runner share a ppid, so the second one's mkdir
 * threw EEXIST out of the preload and Bun killed the worker — which is what
 * "Cannot call describe() after the test run has completed" actually was: the
 * worker died mid-evaluation and its files registered against a finished run.
 * Eight trivial one-line tests reproduced it at --parallel=4 (2 pass, 6 fail),
 * so it was never about the tests. ppid also gets recycled and can reparent to
 * 1/2, which made the lock collide across unrelated runs — 107 stale
 * `axon-tui-test-bootstrap-*` directories had accumulated in /tmp, every one
 * of them a lock nobody would ever release.
 *
 * BUN_TEST_RUN_ID is stable across a runner's workers and unique per run, so
 * it names the thing the lock is actually about. Falling back to ppid keeps
 * single-process runs (where it IS the runner) working.
 */
const sweepLock = join(tmpdir(), `axon-tui-test-bootstrap-${process.ppid}`)

// mkdirSync, not `await mkdir`: sibling workers DO share a ppid, so all but one
// hit EEXIST — and an async rejection during preload evaluation escapes this
// try/catch under --parallel and kills the worker, where a sync throw is caught
// normally. That escape is the entire "Cannot call describe() after the test run
// has completed" failure: the worker died mid-evaluation and its files then
// registered against a run that had already finished.
let ownsProcessSweep = false
try {
    // Atomic: exactly one worker creates the directory and therefore sweeps.
    mkdirSync(sweepLock)
    ownsProcessSweep = true
} catch (error) {
    // EEXIST is the expected path for every worker but the first.
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
}

if (ownsProcessSweep) {
    try {
        Bun.spawnSync(["pkill", "-f", "libs/axon/packages/docker/boot.ts"])
    } catch {
        // no matching processes — pkill exits non-zero, nothing to clean up
    }

    // Sweep locks older than an hour. A process.on("exit") handler does not
    // reliably fire in Bun's test workers, so the lock cannot be released at
    // the end of its own run — 113 of them had piled up in /tmp. Clearing stale
    // ones on the way in is self-healing and needs nothing to fire on the way
    // out; an hour is far longer than any run and far shorter than the ppid
    // reuse that would otherwise make a leaked lock suppress a real sweep.
    const HOUR_MS = 60 * 60 * 1000
    try {
        for (const entry of readdirSync(tmpdir())) {
            if (!entry.startsWith("axon-tui-test-bootstrap-")) continue
            const path = join(tmpdir(), entry)
            if (path === sweepLock) continue
            if (Date.now() - statSync(path).mtimeMs < HOUR_MS) continue
            rmSync(path, { recursive: true, force: true })
        }
    } catch {
        // best-effort — a leaked lock is untidy, not broken
    }
}

const repo = Repo()
const { backendUrl } = await repo.daemon.connect()

// Stripe test-mode secret key — same one the local staging backend runs
// against. Loaded directly from the backend's own env file rather than
// duplicated here.
if (!process.env.STRIPE_SECRET_KEY) {
    const envFile = Bun.file(`${import.meta.dir}/../../../../apps/backend/.env.local`)
    if (await envFile.exists()) {
        const match = (await envFile.text()).match(/^STRIPE_SECRET_KEY=(.+)$/m)
        if (match) process.env.STRIPE_SECRET_KEY = match[1].trim()
    }
}

/**
 * Deploy/publish tests spend TEST_USER's real balance on real billing
 * commitments — with nothing refilling it, repeated runs eventually hit
 * InsufficientFundsError. Top up via the real Stripe test-mode charge flow
 * whenever the balance drops below a floor, so the suite is self-sustaining
 * run over run. Mirrors libs/cloud/tests/setup/preload.ts exactly.
 */
const TOPUP_FLOOR_MINOR = 2_000_00
const TOPUP_AMOUNT_MINOR = 5_000_00

async function ensureFunded(): Promise<void> {
    const { AxonCloud } = await import("@arcforge/cloud")
    const { TEST_USER } = await import("./user")
    const cloud = AxonCloud({ baseUrl: backendUrl, key: TEST_USER.apiKey })

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
