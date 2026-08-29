import { createHash, randomUUID } from "node:crypto"

/**
 * Mint a throwaway, fully-funded test identity.
 *
 * Every test in this suite used to authenticate as the single seeded
 * TEST_USER, which made the shared account a hidden coupling: one test's
 * deployment posted a commitment_charge that another test's balance
 * assertion picked up, and four separate tests failed intermittently for
 * reasons that had nothing to do with what they were testing. Scoping
 * assertions to individual ledger entries fixed the symptom; a test that
 * owns its own account removes the coupling.
 *
 * It is also what makes running suites concurrently safe — with one shared
 * identity, parallelism means tests bill each other.
 *
 * Written straight to the database rather than through the API on purpose:
 *   - there is no "create user" endpoint, and adding one purely for tests
 *     would put a privileged path in production code
 *   - funding via the real Stripe test-mode flow (what preload.ts does for
 *     TEST_USER) costs a network round-trip per identity, which would make
 *     per-test identities far slower than the shared account they replace
 *
 * The seeded funding path (seed.sql: a posted `manual_credit` ledger entry)
 * is exactly what this reuses, so the real billing code — ensureBillingAccount,
 * reserveFunds, captureReservation — still runs end to end against it.
 */

export type IsolatedCloud = {
    /** AxonCloud authenticated as a fresh, funded, empty-registry identity. */
    cloud: ReturnType<typeof import("../../src").AxonCloud>
    who: TestIdentity
}

/**
 * Run `body` against an identity that exists only for this test, then delete it.
 *
 * Use this wherever a test asserts on account-wide state — a balance, a
 * commitment list, a registry listing. Those assertions are only true if
 * nothing else is touching the account, which is exactly what the shared
 * TEST_USER cannot promise.
 *
 * Tests that just need "some authenticated caller" can keep using TEST_USER;
 * minting is cheap (~50ms) but not free, and a test that reads nothing global
 * gains nothing from isolation.
 */
export async function withIdentity<T>(label: string, body: (ctx: IsolatedCloud) => Promise<T>): Promise<T> {
    const { AxonCloud } = await import("../../src")
    const { backendUrl, databaseUrl } = await import("./staging")

    const who = await testIdentity(databaseUrl(), label)
    const cloud = AxonCloud({ baseUrl: backendUrl(), key: who.apiKey })

    try {
        return await body({ cloud, who })
    } finally {
        await who.cleanup()
    }
}

export type TestIdentity = {
    id: string
    email: string
    username: string
    apiKey: string
    /** Remove the identity and everything it owns. */
    cleanup: () => Promise<void>
}

/** Matches seed.sql — enough to cover any tier across many deploys. */
const FUNDING_MINOR = 100_000_00

const ALL_SCOPES = [
    "agents:read", "agents:deploy", "agents:connect", "agents:delete",
    "modules:read", "modules:publish", "modules:delete",
    "cognets:read", "cognets:publish", "cognets:delete",
    "benches:read", "benches:publish", "benches:delete",
    "orgs:read", "orgs:manage", "billing:read", "keys:manage",
    "engine:invoke", "events:ingest",
].join(",")

function sql(dbUrl: string, statement: string): Promise<string> {
    const proc = Bun.spawn(["psql", dbUrl, "-v", "ON_ERROR_STOP=1", "-tAc", statement], {
        stdout: "pipe",
        stderr: "pipe",
    })
    return Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]).then(([out, err, code]) => {
        if (code !== 0) throw new Error(`[identity] psql failed: ${err.trim() || `exit ${code}`}`)
        return out.trim()
    })
}

/**
 * Create an isolated, funded identity. Caller owns cleanup().
 *
 * @param dbUrl staging database, from Repo().daemon.connect()
 * @param label appears in the username, so a leaked row says which suite made it
 */
export async function testIdentity(dbUrl: string, label = "iso"): Promise<TestIdentity> {
    const id = randomUUID()
    const short = id.slice(0, 8)
    const username = `t-${label}-${short}`
    const email = `${username}@axon.test`
    const apiKey = `axon_test_${id.replace(/-/g, "")}`
    const keyHash = createHash("sha256").update(apiKey).digest("hex")

    // One statement: a partially-created identity (user but no key, key but no
    // funds) would fail later in a way that looks like a product bug.
    await sql(
        dbUrl,
        `BEGIN;
         INSERT INTO auth.users (id, instance_id, email, encrypted_password, email_confirmed_at,
                                 raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
         VALUES ('${id}', '00000000-0000-0000-0000-000000000000', '${email}',
                 '$2a$10$PfeAP2HJFJMqggH4DFFY2.0smjEF0E8.G5UcHe6F5Q5OaFyTRPVCC', now(),
                 '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated', now(), now());

         INSERT INTO public.users (id, email, username, name, is_staff, created_at, updated_at)
         VALUES ('${id}', '${email}', '${username}', 'Isolated Test User', true, now(), now())
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, is_staff = EXCLUDED.is_staff;

         INSERT INTO api_keys (id, user_id, key_hash, name, type, is_active, scopes, created_at)
         VALUES (gen_random_uuid(), '${id}', '${keyHash}', 'Isolated test key',
                 'user', true, '{${ALL_SCOPES}}', now());

         INSERT INTO billing_accounts (owner_type, owner_user_id, currency, created_at, updated_at)
         VALUES ('user', '${id}', 'gbp', now(), now())
         ON CONFLICT (owner_user_id) WHERE owner_type = 'user' AND owner_user_id IS NOT NULL DO NOTHING;

         INSERT INTO billing_ledger_entries (billing_account_id, kind, status, amount_minor,
                                             currency, description, reference_type, reference_id, created_at)
         SELECT ba.id, 'manual_credit', 'posted', ${FUNDING_MINOR}, 'gbp',
                'Isolated test identity funding', 'test-identity', '${id}', now()
         FROM billing_accounts ba WHERE ba.owner_user_id = '${id}';
         COMMIT;`,
    )

    return {
        id,
        email,
        username,
        apiKey,
        // auth.users cascades to public.users, api_keys, billing_accounts and
        // registry_artifacts — but deployments.owner_id is RESTRICT, not
        // CASCADE, so a test whose deployment outlived it (an assertion failed
        // before delete(), or the test never deleted at all) would otherwise
        // fail cleanup with a foreign key violation and leak the identity.
        // Dropping deployments first makes cleanup unconditional.
        cleanup: async () => {
            await sql(
                dbUrl,
                `BEGIN;
                 DELETE FROM deployments WHERE owner_id = '${id}';
                 DELETE FROM auth.users  WHERE id = '${id}';
                 COMMIT;`,
            )
        },
    }
}
