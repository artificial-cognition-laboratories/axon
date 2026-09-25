/**
 * Seeded staging identities — see apps/backend/supabase/seed.sql, applied
 * once at first-ever `supabase start` (idempotent ON CONFLICT inserts, so
 * safe to re-run, but not re-applied on every daemon boot).
 *
 * TEST_USER is staff (admin of the `axon` org) and pre-funded — the
 * identity every "logged in, privileged, can spend" test should adopt.
 * OTHER_USER is a second, unprivileged identity for isolation/negative
 * tests (must not see TEST_USER's private data, must not pass staff gates).
 *
 * Bootstrapping via a real key, not device flow: the device-flow approve
 * endpoint itself requireAuths, so nothing can complete a first login
 * through HTTP alone. These keys exist in the DB from seed time — no flow
 * needed to acquire them.
 */
export const TEST_USER = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "test@axon.dev",
    /** Registry scope. Every published name must be @username/... — see scopedName(). */
    username: "testuser",
    /** raw axon_... key — sha256(key) matches api_keys.key_hash from seed.sql */
    apiKey: "axon_test_key_0000000000000000000000000000001",
}

export const OTHER_USER = {
    id: "00000000-0000-0000-0000-000000000002",
    email: "other@axon.dev",
    username: "otheruser",
    /** raw axon_... key — for permission-boundary tests (member-vs-non-member, cross-user isolation) */
    apiKey: "axon_test_key_0000000000000000000000000000002",
}

/**
 * A throwaway, registry-legal artifact name.
 *
 * The registry requires every name to be scoped (`@scope/name`) — publishing to
 * the flat global namespace is refused by resolvePublishNamespace. Nine test
 * files each had their own unscoped `disposableName()`, so all of them failed at
 * `POST /api/user/agents` before reaching the behaviour under test. One helper,
 * scoped to a seeded user, so a fixture cannot drift out of legality again.
 *
 * @param prefix distinguishes suites in the registry (e.g. "deploy", "secrets")
 * @param user   whose namespace to publish under — OTHER_USER for isolation tests
 */
export function scopedName(prefix = "test-fixture-agent", user: { username: string } = TEST_USER): string {
    return `@${user.username}/${prefix}-${crypto.randomUUID().slice(0, 8)}`
}
