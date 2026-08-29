import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

/**
 * Seeded staging identities — see apps/backend/supabase/seed.sql, applied
 * once at first-ever `supabase start` (idempotent ON CONFLICT inserts, so
 * safe to re-run, but not re-applied on every daemon boot).
 *
 * TEST_USER is staff (admin of the `axon` org) and pre-funded — the
 * identity every "logged in, privileged, can spend" test should adopt.
 * OTHER_USER is a second, unprivileged identity for isolation/negative
 * tests (must not see TEST_USER's private data, must not pass staff gates).
 */
export const TEST_USER = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "test@axon.dev",
    /** The namespace this user may publish under — registry names must be scoped. */
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
 * A disposable, publishable package name. The registry refuses unscoped
 * names, so every test that publishes must scope its fixture to a namespace
 * its authenticated user actually owns.
 */
export function scopedName(prefix: string, username: string = TEST_USER.username): string {
    return `@${username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * The framework version tests construct Platform() with.
 *
 * It no longer has to be a published version: fixtures resolve the framework
 * from the WORKING TREE (TEST_FRAMEWORK below), so nothing installs this
 * range from npm. It is still the real version because generated artifacts
 * stamp it and a few assertions read it back.
 *
 * Read SYNCHRONOUSLY. A top-level `await` here makes this module async, and
 * an async module's bindings are observable-but-uninitialized to an importer
 * that is still resolving — so under `bun test --parallel` (what `bun run
 * test` uses) every file importing this crashed with "Cannot access
 * 'TEST_VERSION' before initialization". Serial runs happened to order the
 * graph safely and hid it.
 */
export const TEST_VERSION: string = (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string }
).version

/**
 * How test fixtures resolve the framework — from this repo, never from npm.
 *
 * This is the fix for a whole class of release bug. A suite that installed
 * @arcforge/* from the registry was testing the LAST RELEASE, not the commit:
 * a change to a published package could not go green until it was published,
 * and could not be published until it was green. Worse, it went green on code
 * that was actually broken — a barrel export that dragged the TypeScript
 * compiler into every agent bundle passed every unit suite and only failed
 * once a real agent installed it.
 *
 * Linking makes a fixture compile the code under test, so a boundary change
 * fails here instead of in a user's first run.
 *
 * Spread into Platform(): `Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK })`.
 */
export const TEST_FRAMEWORK = {
    frameworkSource: "workspace",
    repoRoot: fileURLToPath(new URL("../../../../../", import.meta.url)),
} as const

/**
 * The counterpart, for suites that PUBLISH what they scaffold.
 *
 * Empty on purpose — it resolves the framework from npm, exactly as a user
 * does. A published artifact carrying `file:` dependencies resolves only on
 * the machine that built it, so the registry refuses one (see the backend's
 * publish route), and a linked fixture cannot be published at all.
 *
 * It exists as a NAMED value rather than "just omit TEST_FRAMEWORK" so the
 * choice is visible at the call site and survives a careless find-and-replace.
 * Anything that publishes, deploys, clones or forks uses this; everything
 * else links.
 */
export const TEST_FRAMEWORK_PUBLISHED = {} as const
