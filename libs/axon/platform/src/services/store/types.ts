/** Record shapes as they exist on disk under ~/.axon. */

export type EnvTarget = "local" | "cloud"

export type UpdateRecord = {
    status: "pending" | "running" | "complete" | "failed" | "rolled-back"
    from: string
    to: string
    updatedAt: string
    error?: string
}

/** profiles/index.json — which profile is active. */
export type ActiveProfile = {
    userId: string
}

/** profiles/<id>/store/profile.json — identity + credentials. */
export type ProfileRecord = {
    user: {
        id: string
        email: string
        name?: string
        memberSince?: string
    }
    auth: {
        accessToken?: string
        expiresAt?: number
        apiKey?: string
    }
}

/** profiles/<id>/store/settings.json — user preferences, TUI + CLI. */
/**
 * Verbosity profile — per-channel control over what the thread timeline
 * renders. The debugging dial: all defaults are the everyday view; turning
 * channels on interleaves the machinery's own records into the timeline.
 */
/**
 * Re-exported, not redefined.
 *
 * These are the EXTENSION CONTRACT — a user's `profile.config.ts` is typed
 * against the copy in `@arcforge/types/tui.ts` that `axon prepare` writes into
 * their frame. A second definition here would be the same shape twice, and the
 * day they disagreed a setting would typecheck in the user's editor and be
 * rejected by the terminal reading it.
 */
export type { VerbosityProfile, ProfileSettings } from "@arcforge/types"

/** profiles/<id>/store/history.jsonl — one line per sent message, oldest first on disk. */
/**
 * A standing policy approval — what "allow always" writes.
 *
 * ── Why a store rather than a config edit ───────────────────────────────────
 *
 * The alternative was writing the grant into the agent's own `axon.config.ts`
 * or the profile's. Both are worse: editing a user's authored config from a
 * palette keypress is invasive, and under the ceiling an agent-level grant
 * cannot widen a profile that escalated anyway — so "always" would fail
 * confusingly in exactly the case that produced the prompt.
 *
 * A separate store also makes grants inspectable and revocable as a LIST,
 * which neither config can be: a config says what is permitted, not what was
 * decided, when, or by whom.
 *
 * ── What a grant can and cannot do ──────────────────────────────────────────
 *
 * A grant only ever satisfies an ESCALATION. It can never overturn a `deny`
 * from either layer — "stop asking me this" is a different act from "override
 * the ceiling", and collapsing them would let one keypress undo a machine-wide
 * rule the user set deliberately.
 *
 * ── Keyed by agent NAME ─────────────────────────────────────────────────────
 *
 * Two agents of the same name in different directories share a grant. That is
 * a known simplification: the alternative keys on the project path, which is
 * more correct and less legible in a file a person is meant to read. Revisit
 * when someone actually runs two same-named agents.
 */
export type PolicyGrant = {
    /** Grant id — what a revocation names. */
    id: string
    /** The agent this was granted to, by name. `"*"` grants to every agent on this profile. */
    agent: string
    /** Fully qualified function, e.g. `"process.run"` or `"github.issues"`. */
    fn: string
    /**
     * The subject this covers, as a glob — the command, host, or namespace the
     * escalation was raised for. Matched with the same matcher policy uses, so
     * a grant reads exactly like the rule it satisfies.
     */
    subject: string
    /** When it was granted. */
    grantedAt: number
    /**
     * Set when this entry REVOKES an earlier grant, naming it. Revocation is
     * an append rather than a rewrite: the log is an audit trail, and a
     * decision that was made and later withdrawn is two facts, not zero.
     */
    revokes?: string
}

/**
 * An escalation that was raised — the audit trail, and the queue a surface
 * answers from.
 *
 * Written for EVERY escalation, including ones a human answers immediately.
 * The record is what makes "3 escalations this session, 2 approved" answerable
 * and what lets a request be approved long after the call that raised it gave
 * up — the grant it produces is what the next attempt reads.
 *
 * `outcome` is absent while a request is open. A request with no outcome and
 * no live process behind it is stale rather than pending; a surface listing
 * them should say so rather than offering to answer a call nobody is waiting
 * on.
 */
export type PolicyRequest = {
    /** Request id — what an answer names. Distinct from the capsule's escalation id. */
    id: string
    /** The agent that raised it, by name. */
    agent: string
    /** The session it was raised in — how a surface finds the conversation. */
    sessionId: string
    /** Fully qualified function, e.g. `"process.run"`. */
    fn: string
    /** What was being asked for — the command, host, or namespace. */
    subject: string
    /** When it was raised. */
    raisedAt: number
    /**
     * How it settled, and by what.
     *
     * "grant" means a standing approval covered it and no human was asked.
     * "expired" means nothing was listening — the call already failed, and
     * answering now writes a grant for next time rather than unblocking it.
     */
    outcome?: {
        decision: "allow" | "deny"
        by: "user" | "grant" | "expired"
        at: number
        /** The grant this produced, when the user chose "always". */
        grantId?: string
    }
}

export type HistoryEntry = {
    id: string
    content: string
    /** Name of the agent the message was sent to — null if none was running. */
    agentName: string | null
    createdAt: string
}


/**
 * One agent's last-known shape — what a status line can show before the agent
 * is up.
 *
 * Every field is optional: an agent that has never booted has no manifest, and
 * a manifest written by an older version may be missing whatever was added
 * since. A reader treats absence as "not known yet", which is the same state a
 * cold boot is in anyway.
 */
export type AgentManifest = {
    /** The model it ran on — what the header's "model:" row shows. */
    model?: string
    /** How many modules it loaded. */
    modules?: number
    /** How many tools those modules registered. */
    tools?: number
    /** The session it was last on, so `^` and the session name have something to show. */
    sessionId?: string
    /** Context used at shutdown, in tokens. */
    context?: number
}

/**
 * profiles/<id>/store/state.json — app-remembered continuity data, distinct from
 * settings.json (user-configured preferences). Nothing here is something
 * the user directly edits; it's what the app itself writes to resume
 * where it left off (last agent today, potentially last thread/session
 * later).
 */
/**
 * What the TUI should open on its next boot, written by a CLI command.
 *
 * `axon attach <url>` and `axon open <session>` do not do their work in the
 * CLI process — there is no terminal UI there to attach TO. They record an
 * intent and return, which makes vterm boot the app, and the app performs it
 * on mount exactly as if the user had typed the command inside.
 *
 * ONE-SHOT, and that is the whole difference from `AppState`. State is
 * continuity — the agent you were last on, re-selected every launch forever.
 * An intent is an instruction that has been carried out: left in place it
 * would re-attach to a URL on every subsequent start, long after the user
 * moved on. It is cleared as it is read.
 *
 * A discriminated union rather than a bag of optional fields: two intents can
 * never be pending at once, and a reader switches on `kind` rather than
 * guessing which combination of fields it was handed.
 */
export type AppIntent =
    /**
     * Open the terminal on an agent — what `-a` records.
     *
     * `ref` is the SAME reference form the CLI accepts everywhere: a path, a
     * package, or a URL. The reader decides what that means, because the two
     * cases genuinely differ — a URL is an agent already running, so it is
     * bound to; a path or package names one that has to be spawned first.
     *
     * It was `url` only, when attaching was its own command and only a running
     * address could be named. Widening it is what lets `axon @cody/zeno -a`
     * and `axon ./zeno -p "hi" -a` land in the same place as an attach: the
     * user asked for the same thing — a terminal on this agent — and the
     * transport is an implementation detail of which reference they used.
     */
    | {
        kind: "attach"
        ref: string
        /**
         * Messages to deliver once the terminal is up — what
         * `axon <ref> -p "…" -a` records.
         *
         * An ARRAY, because each `-p` is its own message: they land in the
         * TUI's queue in order and are sent as the agent becomes free,
         * exactly as if the user had typed them one after another. Joining
         * them into one instruction (which is what `-p` does WITHOUT `-a`,
         * where there is one turn to run) would collapse a conversation
         * into a single prompt.
         *
         * Carried rather than run CLI-side: `-a` says the conversation
         * continues in the terminal, so running the turn first meant
         * watching it complete in one place and then opening a second to
         * see it again.
         */
        send?: string[]
    }
    /**
     * Reopen a session — focus it if live, otherwise boot its agent onto it.
     *
     * Carries the agent's ADDRESS as well as the id, because resuming boots
     * the agent the session belongs to and a log id does not name one. The
     * command that records this already knows both (it resolved the session
     * to show it), so making the reader search every agent's logs for an id
     * would be re-deriving what the writer had.
     */
    | { kind: "session"; sessionId: string; agent: string }

export type AppState = {
    /**
     * ADDRESS (directory name) of the last agent selected — the TUI auto-boots
     * this on startup, if present. An address, not an identity: it is fed back
     * to resolve(), and a package name ("@axon/zeno") contains a "/" that
     * resolve() reads as a path.
     */
    lastAgent?: string

    /**
     * Last known model per agent, keyed by ADDRESS.
     *
     * Purely a render cache for the header's "model:" row. That value is read
     * off the agent's live blueprint, which does not exist until boot
     * completes, so a cold start showed a spinner for the whole boot even
     * though the answer had not changed since last run. Written on every
     * successful boot, read only while booting, and always superseded by the
     * live blueprint the moment it lands — a stale entry is visible for one
     * boot at most, and never overrides truth.
     */
    agentModels?: Record<string, string>

    /**
     * What each agent looked like when it last shut down, keyed by ADDRESS.
     *
     * The generalisation of `agentModels`, and the same reasoning: every value
     * a status line shows is read off a live blueprint or session, none of
     * which exist until boot completes. A cold start therefore rendered a bar
     * of empty sections for the second or so the agent took to come up, and
     * the row visibly filled in piece by piece — which reads as a broken
     * layout rather than as loading.
     *
     * Written on shutdown and on every successful boot, read only while
     * booting, and superseded by live values the moment they land. A stale
     * entry is visible for one boot at most and never overrides truth — the
     * same contract `agentModels` states, widened to the rest of the row.
     *
     * Deliberately NOT a general component cache. Only values that are
     * expensive to learn and stable across a restart belong here; a clock or a
     * process id is cheaper to compute than to remember.
     */
    agentManifests?: Record<string, AgentManifest>

    /**
     * Model picks, most recent first — canonical `route:model/id` strings
     * ("codex:openai/gpt-5.5", "axon:auto").
     *
     * The model palette is one flat list of every (route, model) pair, which is
     * ~800 rows. Recency is what makes that navigable without typing: the
     * handful anyone actually uses sit at the top, and everything else is a few
     * keystrokes of search away. Capped — this is a convenience ordering, not a
     * usage log, and an unbounded list would just be a slower one.
     */
    recentModels?: string[]
}
