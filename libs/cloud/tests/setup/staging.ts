import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AxonCloud } from "../../src"

/**
 * Where the staging backend and database live, resolvable from any process.
 *
 * `tests/setup/preload.ts` sets AXON_API_BASE and DATABASE_URL, which is fine
 * for a normal run — but `bun test --parallel` does NOT run preloads in its
 * worker processes (verified against Bun 1.3.14, including with an explicit
 * --preload flag). Workers therefore started with both vars unset, AxonCloud
 * fell back to its production default, and 50+ tests failed with 401s against
 * the real API. Reading env alone makes the suite silently un-parallelisable.
 *
 * The daemon already writes its URLs to a lockfile on disk, so that file — not
 * an inherited environment — is the source of truth every worker can reach.
 * Env still wins when set, so a deliberate override (CI pointing at a
 * different stack) keeps working.
 */

type DaemonLock = { urls?: Record<string, string> }

const LOCK_PATH = join(homedir(), ".arclabs", "repo.lock")

function fromLock(key: string): string | null {
    if (!existsSync(LOCK_PATH)) return null
    try {
        const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as DaemonLock
        return lock.urls?.[key] ?? null
    } catch {
        // A torn read (daemon writing while we read) is not a reason to fall
        // back to production — the caller throws below, loudly.
        return null
    }
}

function resolve(envVar: string, lockKey: string, hint: string): string {
    const fromEnv = process.env[envVar]
    if (fromEnv) return fromEnv

    const url = fromLock(lockKey)
    if (url) return url

    throw new Error(
        `[staging] no ${envVar} and no "${lockKey}" in ${LOCK_PATH} — ${hint}. ` +
            `Start the stack with \`bun run libs/repo/bin/arc.ts up\`.`,
    )
}

/** Staging backend base URL. Never falls back to production. */
export function backendUrl(): string {
    return resolve("AXON_API_BASE", "backend", "the staging backend is not running")
}

/**
 * A client with NO credential — genuinely anonymous, whoever runs the suite.
 *
 * `anonymousCloud()` is not anonymous: `environmentCredentials` defaults
 * true, so it silently adopts AXON_API_KEY / AXON_CONNECT_TOKEN from the
 * environment. apps/tui/.env sets AXON_API_KEY for local CLI convenience and
 * Bun auto-loads it, so every "requires auth" test then authenticated as that
 * key and failed for asserting a rejection that correctly never came — 32 of
 * them, but only when run from a shell that had it.
 *
 * Deleting the vars in the preload does NOT work: Bun re-applies the
 * auto-loaded .env inside each `--parallel` worker, so the deletion survives a
 * serial run and vanishes in the parallel one the ship gate actually uses.
 * Verified directly — serial saw "(unset)", parallel saw the key.
 *
 * So anonymity is stated at the call site instead of assumed from the
 * environment, which is what a test asserting "requires auth" should have been
 * doing regardless: it is the condition under test, not a precondition to
 * inherit.
 */
export function anonymousCloud(): ReturnType<typeof AxonCloud> {
    return AxonCloud({ baseUrl: backendUrl(), environmentCredentials: false })
}

/** Staging database URL. */
export function databaseUrl(): string {
    return resolve("DATABASE_URL", "db", "the staging database is not running")
}

/**
 * Stripe test-mode secret, for the tests that confirm a real SetupIntent.
 *
 * preload.ts reads this out of the backend's own .env.local — but preloads do
 * not run in `--parallel` workers, so those tests hit Stripe with an undefined
 * key and failed with "Invalid API Key provided: undefined". Reading the same
 * file here makes it worker-independent, and keeps the single source of truth
 * (the backend's env) rather than duplicating the secret into test config.
 */
export function stripeSecretKey(): string {
    const fromEnv = process.env.STRIPE_SECRET_KEY
    if (fromEnv) return fromEnv

    const envPath = join(import.meta.dir, "../../../../apps/backend/.env.local")
    if (existsSync(envPath)) {
        const match = readFileSync(envPath, "utf8").match(/^STRIPE_SECRET_KEY=(.+)$/m)
        if (match?.[1]) return match[1].trim()
    }

    throw new Error(
        `[staging] no STRIPE_SECRET_KEY in the environment or ${envPath} — ` +
            `card tests cannot confirm a SetupIntent without it.`,
    )
}

/** Below this, a single `small` deploy can fail — refill before it bites. */
const FUNDING_FLOOR_MINOR = 500_00
const REFILL_MINOR = 1_000_000_00

/**
 * Guarantee the shared TEST_USER can afford the deployments a run will make.
 *
 * preload.ts tops TEST_USER up through the real Stripe test-mode flow, but
 * preloads do not run in `bun test --parallel` workers — so a parallel run
 * drained the account and 24 tests failed with "insufficient balance to
 * deploy: need 4900, have 36". That reads exactly like a billing regression
 * and is not one.
 *
 * This is the same credit seed.sql posts, written straight to the ledger: no
 * Stripe round-trip, so it is cheap enough for any worker to call, and
 * idempotent-by-floor so concurrent workers cannot over-fund. The real
 * reserve/capture path still runs against the balance it creates.
 *
 * Tests that own their identity (see withIdentity) do not need this — they are
 * funded at mint. It exists for the ones still sharing TEST_USER.
 */
export async function ensureStagingFunds(userId = "00000000-0000-0000-0000-000000000001"): Promise<void> {
    const dbUrl = databaseUrl()

    const balance = await psql(
        dbUrl,
        `SELECT coalesce(sum(le.amount_minor), 0)
         FROM billing_ledger_entries le
         JOIN billing_accounts ba ON ba.id = le.billing_account_id
         WHERE ba.owner_user_id = '${userId}' AND le.status = 'posted';`,
    )

    if (Number(balance) >= FUNDING_FLOOR_MINOR) return

    await psql(
        dbUrl,
        `INSERT INTO billing_ledger_entries (billing_account_id, kind, status, amount_minor,
                                             currency, description, reference_type, reference_id, created_at)
         SELECT ba.id, 'manual_credit', 'posted', ${REFILL_MINOR}, 'gbp',
                'Staging refill — keeps the shared suite solvent', 'test-refill',
                gen_random_uuid()::text, now()
         FROM billing_accounts ba WHERE ba.owner_user_id = '${userId}';`,
    )
}

async function psql(dbUrl: string, statement: string): Promise<string> {
    const proc = Bun.spawn(["psql", dbUrl, "-v", "ON_ERROR_STOP=1", "-tAc", statement], {
        stdout: "pipe",
        stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    if (code !== 0) throw new Error(`[staging] psql failed: ${err.trim() || `exit ${code}`}`)
    return out.trim()
}
