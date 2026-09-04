import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Platform, type PlatformT } from "@arcforge/platform/platform"
import { Axond } from "../../src/axond"
import { TEST_VERSION, TEST_FRAMEWORK, TEST_USER } from "./user"

/**
 * A Platform that can actually boot an agent.
 *
 * ── Why these tests live in axond ────────────────────────────────────────────
 *
 * The platform BUILDS an agent — resolve, prepare, blueprint.load — and the
 * daemon RUNS it. That split is deliberate: supervision holds the provider
 * credential, the session log and the escalation decider, and those must
 * outlive whichever terminal happened to call spawn.
 *
 * The consequence is that `platform.agents.spawn()` refuses on a Platform
 * built without a supervisor, and the platform package cannot supply one —
 * axond already depends on platform, so reaching back would be a cycle. So the
 * tests that spawn a real agent live HERE, on the side of the seam that owns
 * the behaviour, wired to the real `Supervise()` rather than to a double.
 *
 * Nothing about them is a daemon test: they still exercise the platform's
 * spawn/reload/shutdown surface. They simply need the half of it that moved.
 *
 * ── The thunk ───────────────────────────────────────────────────────────────
 *
 * `cloud` is read at spawn rather than captured, because the Platform builds
 * the client and the supervisor consumes it — a value here would need one to
 * exist before the other. Deferring the read breaks that cycle without either
 * learning about the other's construction, which is the same reason
 * Supervise() declares it as a thunk in the first place.
 */
export function supervised(store: string): PlatformT {
    let platform: PlatformT
    // eslint-disable-next-line prefer-const -- read through the thunk below,
    // which cannot run before the assignment completes.
    platform = Platform({
        version: TEST_VERSION,
        ...TEST_FRAMEWORK,
        store,
        // `Axond(...).agents` is EXACTLY what the TUI passes (apps/tui/cli/cli.ts).
        // Wiring the tests to the same expression is the point of moving them
        // here: a change that breaks supervision breaks this suite, rather
        // than being discovered when someone runs the terminal.
        daemon: Axond({ cloud: () => platform.cloud.client }).agents,
    })
    // Every test platform, not just the authenticated one: most suites log in
    // AFTER this returns (each hand-rolls its own `login()`), and several never
    // log in at all — yet a scaffolded agent still resolves against the profile
    // pool at spawn. So the config is written by PATH, for whoever the profile
    // turns out to be, rather than for whoever is active right now.
    seedMockProvider(store)
    return platform
}

/**
 * The same platform, with TEST_USER already logged in.
 *
 * The ORDER is the point: `Cloud()` reads the active profile once, when it
 * builds its client, so a profile written onto a live platform lands on disk
 * and never reaches the client already constructed from it. Any test that
 * INVOKES an agent needs the credential — inference is the supervisor's, and
 * an agent holds no key of its own — so the write has to happen through a
 * throwaway platform first.
 *
 * Tests that only build, spawn or list can use `supervised()` directly; the
 * moment one runs a wake, it needs this.
 */
export function authenticated(store: string): PlatformT {
    const seed = supervised(store)
    seed.store.profiles.save(TEST_USER.id, {
        user: { id: TEST_USER.id, email: TEST_USER.email },
        auth: { apiKey: TEST_USER.apiKey },
    })
    return supervised(store)
}

/**
 * Make every test profile's inference pool a MOCK.
 *
 * A scaffolded agent is `defineAgent({})` — it declares no inference at all
 * and resolves entirely against the PROFILE's pool, which defaults to the
 * managed `axon` route (see providerPool's DEFAULT_PROVIDERS). So every test
 * that creates an agent through `projects.create()` and then wakes it reached
 * a real, metered provider. That is not a per-fixture bug: those agents
 * declare nothing deliberately, because that is exactly what `axon init`
 * produces.
 *
 * Writing a profile-level provider fixes it where resolution actually happens,
 * and mirrors what a user does when configuring their own machine. The API key
 * stays seeded — inference is the supervisor's and several tests assert on
 * credential wiring — but nothing metered can be built from it any more.
 *
 * Best-effort: a platform with no active profile has nothing to write to yet,
 * and the next `supervised()` call after the login covers it. The
 * AXON_NO_NETWORK_INFERENCE guard in buildProvider() is the backstop that makes
 * a miss loud rather than billed.
 */
function seedMockProvider(store: string): void {
    // Keyed by EMAIL, which is what `store.profiles` names a profile
    // directory — not the uuid. TEST_USER is the only profile these suites
    // create, so its root is known before the profile exists, which is the
    // point: this runs before the login that would make it active.
    const root = join(store, "profiles", TEST_USER.email)
    mkdirSync(root, { recursive: true })
    writeFileSync(
        join(root, "profile.config.ts"),
        "export default defineProfile({ providers: [Mock()] })\n",
    )
}
