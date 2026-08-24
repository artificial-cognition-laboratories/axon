import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"
import type { AxonCancellableSpan, AxonSpan } from "./span"

/**
 * Runtime + continuity events — the session's own lifecycle record.
 *
 * Two families in one map:
 * - Runtime facts (boot/shutdown/reload/server): "a runtime attached to this
 *   session and did things". A session can span many boots.
 * - Continuity facts (session/capsule): the small, load-bearing subset
 *   hydration reads on resume.
 *
 * No single prefix covers this map (boot:/shutdown:/session:/capsule:/
 * server:), so its log events use "runtime" as the namespace —
 * axon:log:info/warning/error — rather than picking one arbitrary
 * existing prefix to own logging for the whole map.
 *
 * axon:log:* is a distinct namespace within this same map: console output
 * captured from agent-authored code (boot.vue today; the CLI config layer
 * once it's wired to a session too). "axon" names the runtime the user's
 * own code is running inside — not any one lifecycle prefix above — so it
 * gets its own namespace rather than folding into axon:log:*.
 */
/**
 * What an install put somewhere — a module into THIS agent, or an extension
 * into the user's terminal.
 *
 * On the event rather than in a second event family, because the two are the
 * same operation with different destinations: same span, same failure modes,
 * same "installed X in 558ms" line. A parallel `axon:ext:install` triad would
 * be four more event types and a second renderer that must agree with the
 * first about what an install looks like.
 *
 * Absent means module — every event written before extensions could be
 * installed is one, and defaulting keeps those readable.
 *
 * "cognet" is the agent's brain. It updates through the same installer as a
 * module (it IS an ordinary registry package), so it belongs on this span
 * rather than a fourth triad — but it is not a module: it is selected by
 * `cognet:`, never listed under `modules:`, and there is exactly one.
 */
export type ArtifactInstalled = "module" | "extension" | "cognet"

export type AxonRuntimeEvent =
    & AxonLogEvents<"axon">
    // ── Runtime lifecycle ────────────────────────────────────────────────────
    & AxonSpan<"axon:boot", { version: string; agentRoot: string; mode: "local" | "cloud" }>
    & AxonSpan<"axon:shutdown", { reason?: string }>

    // ── Boot's interior ──────────────────────────────────────────────────────
    //    axon:boot bracketed the whole runtime construction and nothing
    //    inside it, so half a boot was one unlabelled gap between
    //    axon:boot:start and the capsule coming up. These four name what
    //    actually runs in that window, in the order Axon() runs them.
    //
    //    The trace is a user-facing surface, so the standard is that no
    //    adjacent pair of spans has a meaningful gap between them: an
    //    unlabelled hole reads as time the system cannot account for.

    /**
     * Resolving the cognet bundle to a live definition — the disk read, the
     * sha256 verification, the per-runtime copy, and the dynamic import.
     *
     * `cognet` carries the brain's name rather than `name`, which is
     * span-identity by convention (the ontology guard pairs brackets on it) —
     * a field appearing only on the closing half would split the span.
     *
     * hashMs/importMs are split because they grow for different reasons:
     * hashing scales with bundle size, the import is JS compile time.
     */
    & AxonSpan<
        "axon:cognet",
        { specifier: string | null },
        { cognet: string; version: string; bytes: number; hashMs: number; importMs: number }
    >

    /**
     * Resolving declared engine roles against the user's providers.
     *
     * The span that was hiding the catalogue fetch. `cached` says whether the
     * hosted catalogue came off disk or the wire — the single most useful bit
     * for anyone asking why a boot was slow.
     */
    & AxonSpan<
        "axon:inference",
        { roles: string[] },
        { bound: number; providers: number; failures: number; cached: boolean }
    >

    /**
     * One provider answering (or failing to answer) what it can supply.
     *
     * Nested inside axon:inference. These genuinely run concurrently, so they
     * carry a spanId — the one case bracket-matching cannot recover nesting
     * on its own.
     */
    & AxonSpan<
        "axon:inference:provider",
        { provider: string; spanId: string },
        { provider: string; spanId: string; capabilities: number; cached: boolean },
        { provider: string; spanId: string; error: AxonError }
    >

    /** Constructing the kernel — ring 0 coming up, before the capsule boots. */
    & AxonSpan<"axon:kernel", {}, {}>
    // ── Surface reload (blueprint/tools changed under a live runtime) ───────
    & AxonSpan<
        "axon:reload",
        { revision: number },
        { revision: number; toolCount: number },
        { revision?: number; error: AxonError }
    >
    /**
     * A variable set in the agent's own .env, then a reload so it is live.
     *
     * THE KEY ONLY, NEVER THE VALUE. This is the path secrets arrive on — an
     * API token, a bot key — and the session log is durable and syncs. Naming
     * the variable is what makes the change auditable ("TELEGRAM_BOT_TOKEN was
     * set at 14:02"); recording what it was set to would write every secret
     * the user ever types into a permanent record. The one is the audit trail,
     * the other is a leak, and they are separated here rather than left to
     * each caller to remember.
     */
    & AxonSpan<
        "axon:env:set",
        { key: string },
        { key: string },
        { key: string; error: AxonError }
    >
    /**
     * Connecting the agent to an outside surface — Discord, Telegram, Slack.
     *
     * A guided flow the user drives, not a background operation: each step
     * renders a card, and the flow waits where the step says to wait. It is a
     * MODE — either the agent is working or you are connecting something to it
     * — which is why it is cancellable. Escape ends it the same way it stops a
     * wake, and `:interrupted` says the user did what they meant to rather
     * than that something broke.
     *
     * NO CREDENTIAL EVER LANDS HERE. The token arrives on this path, and this
     * log is durable and syncs — the same rule as `axon:env:set`, which records
     * the key and never the value. `summary` names WHO the credential turned
     * out to be ("MyBot#4821"), which the platform handed back.
     */
    & AxonCancellableSpan<
        "axon:connect",
        { connector: string; title: string },
        { connector: string; summary: string },
        { connector: string; error: AxonError },
        { connector: string }
    >
    /**
     * One card inside a connect flow.
     *
     * Carries what the card SHOWS rather than a formatted line: the renderer
     * decides how a step reads, and the flow only commits the facts. `body` is
     * markdown because the interaction is conversational — a step reads like
     * the agent explaining what to do next, which is what it is.
     */
    & {
        "axon:connect:step": {
            connector: string
            /** The card's heading — "2/4 · paste your token". */
            note: string
            /** Markdown body, rendered like an agent message. */
            body?: string
            /** Shown as the step's link, and what Enter opens. */
            url?: string
            /** Lets the renderer show the right affordance for the step. */
            stepKind?: "instruct" | "input" | "work"
        }
    }
    // ── Module install/uninstall (registry op, then a reload rides the same
    //    hot-swap path above) ─────────────────────────────────────────────
    & AxonSpan<
        "axon:install",
        { name: string; version?: string; artifact?: ArtifactInstalled },
        { name: string; version: string; alreadyInstalled: boolean; artifact?: ArtifactInstalled },
        { name: string; version?: string; error: AxonError; artifact?: ArtifactInstalled }
    >
    & {
        /**
         * No module by that name in the registry — a typo or an unpublished
         * package. A settled outcome, not a failure: nothing broke, so it must
         * not render as an error. Distinct from :failed, which means the
         * install itself went wrong (network, disk, a bad tarball).
         *
         * Outside the span triad by design — a third settled outcome, the
         * same way :interrupted is for cancellable operations.
         */
        "axon:install:not-found": { name: string; durationMs: number }
    }
    /**
     * `artifact` for the same reason install carries it: removing a module
     * from an agent and removing an extension from the terminal are the same
     * operation with different destinations, and the timeline has to be able
     * to say WHICH — "removed @cody/vim" is ambiguous otherwise.
     *
     * Absent means module, matching install: every event written before
     * extensions were uninstallable is one.
     */
    & AxonSpan<
        "axon:uninstall",
        { name: string; artifact?: ArtifactInstalled },
        { name: string; artifact?: ArtifactInstalled },
        { name: string; error: AxonError; artifact?: ArtifactInstalled }
    >
    /**
     * Moving already-installed artifacts to newer published versions.
     *
     * ── Plural, unlike install and uninstall ────────────────────────────────
     *
     * Those two act on one name because that is how a user asks for them. An
     * update is naturally a SET — "update everything that is out of date" is
     * the common case, and the module installer applies it as one manifest
     * write, one `bun install` and one reload. Modelling it as N single-name
     * spans would put N restarts on the timeline for one user action, and
     * would misreport the atomicity: those modules moved together or not at
     * all.
     *
     * ── `updated` and `failed` are both carried ─────────────────────────────
     *
     * A batch settles PARTIALLY. One unpublished or unreachable name must not
     * discard the versions that did move, so the completion records both sides
     * rather than reducing to a boolean. `:failed` stays for a real fault —
     * disk, a broken install — where nothing can be said about individual
     * names.
     *
     * `artifact` for the same reason install and uninstall carry it: updating
     * an agent's module and updating a terminal extension are the same
     * operation aimed at different places, and "updated @cody/vim" is
     * ambiguous without it.
     */
    & AxonSpan<
        "axon:update",
        { names: string[]; artifact?: ArtifactInstalled },
        {
            names: string[]
            artifact?: ArtifactInstalled
            updated: Array<{ name: string; version: string }>
            failed: Array<{ name: string; error: string }>
        },
        { names: string[]; error: AxonError; artifact?: ArtifactInstalled }
    >
    // ── Model change (config edit, then a reload rides the hot-swap path) ───
    //    The agent is the same agent; only the engine underneath it moved.
    //    `dropped` names options the previous provider had that the new one
    //    does not accept (e.g. Codex's `effort`), so the change is never a
    //    silent loss of the author's configuration.
    & AxonSpan<
        "axon:model",
        { name: string },
        { name: string; changed: boolean; dropped: string[] },
        { name: string; error: AxonError }
    >
    // ── Module setup/teardown (boot-time defineModule() setup execution) ─────
    //    The determinism ledger: one start/complete (or failed) per module,
    //    in blueprint order, carrying the config content hash so two boots of
    //    the same blueprint are provably the same wiring.
    & AxonSpan<
        "module:setup",
        { name: string; configHash: string; options: Record<string, unknown> },
        { name: string },
        { name: string; error: AxonError }
    >
    & AxonSpan<
        "module:dispose",
        { name: string },
        { name: string },
        { name: string; error: AxonError }
    >
    & {
    // ── Session continuity ───────────────────────────────────────────────────
    //    NOT a span, and deliberately not named like one. A session outlives
    //    the runtime that opened it: `opened` and `closed` can be days and
    //    several processes apart, with any number of boots in between, so
    //    there is no bracket here for a reader to match or a flame graph to
    //    draw. `axon:session:start` collided with the span vocabulary and
    //    read as a bracket that never closed — these verbs keep the
    //    continuity family honestly outside it.
    "axon:session:opened": {}
    "axon:session:restored": {}
    "axon:session:closed": {}

    // ── Capsule attachment (one capsule per session; telemetry lives in the capsule package) ──
    "capsule:attach": { capsuleId: string; cwd: string }
    "capsule:detach": { capsuleId: string; reason: "shutdown" | "crash" | "reload" }

    // ── Server ───────────────────────────────────────────────────────────────
    "axon:server:request": { method: string; path: string; status: number; durationMs: number }

    // ── Errors ───────────────────────────────────────────────────────────────
    "axon:error": { event?: string; error: AxonError }
    /**
     * A bus handler threw. "axon" names the runtime layer the failure
     * happened in, not any one lifecycle prefix above.
     *
     * Carries the full AxonError (envelope rule 4) — plugins and modules
     * register handlers, so a stringified message would drop the stack at
     * exactly the boundary where "which plugin broke?" is the only question
     * worth answering.
     */
    "axon:bus:error": { event: string; error: AxonError }
}
