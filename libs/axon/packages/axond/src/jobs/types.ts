/**
 * Who did a thing.
 *
 * ── Why this is not a string ────────────────────────────────────────────────
 *
 * An agent can run `axon job` — that is a feature, a subagent delegating work
 * is real. But an agent must never be able to acknowledge its OWN work as
 * complete, or the list stops meaning anything: everything would arrive
 * already ticked off by the thing that did it.
 *
 * So every record and every event names its actor, and the verbs that belong
 * to a person check it.
 *
 * ── What makes the human mark trustworthy ───────────────────────────────────
 *
 * The mark is possession of the signed-in account, read from the store. Its
 * strength is exactly the strength of agent confinement: a confined agent has
 * no credential and cannot read the store, which is the invariant `Supervise`
 * exists to enforce. It is NOT a signature, and it is not proof against
 * something already running unconfined as this user — such a process can
 * reach the daemon socket and read the store, and nothing at this layer
 * changes that. Claiming otherwise would be worse than the honest limit.
 */
export type Actor =
    | { kind: "human"; account: string }
    | { kind: "agent"; session: string }

/**
 * One thing that happened to a job.
 *
 * The log is APPEND-ONLY and state is folded from it — see `fold`. That is a
 * deliberate bet on the multi-machine case: many writers appending is an
 * ordering question with an answer, while many writers SETTING a status field
 * is data loss. It costs nothing locally, where there is one writer.
 */
export type JobEvent =
    | { kind: "created"; at: string; by: Actor; machine: string | null; title: string; content: string; agent: string | null; cwd: string | null }
    /** A machine took the work. Carries the lease so a stalled claim can be seen. */
    | { kind: "claimed"; at: string; by: Actor; machine: string; until: string }
    | { kind: "started"; at: string; by: Actor; session: string }
    /** Anything either side said after the opening prompt. */
    | { kind: "said"; at: string; by: Actor; text: string }
    /** The agent needs a person. `question` is what to show in "Needs you". */
    | { kind: "blocked"; at: string; by: Actor; question: string }
    | { kind: "finished"; at: string; by: Actor; summary: string | null }
    | { kind: "failed"; at: string; by: Actor; reason: string }
    | { kind: "cancelled"; at: string; by: Actor }
    /** The PERSON marking it dealt with. Never the agent — see Actor. */
    | { kind: "acknowledged"; at: string; by: Actor }

/**
 * How the agent's run is going.
 *
 * Deliberately separate from whether the PERSON is done with it. Collapsing
 * the two means either the agent gets to clear your list or you cannot clear
 * it yourself — see `Job.acknowledged`.
 */
export type JobRun =
    | "queued"
    | "claimed"
    | "running"
    | "blocked"
    | "finished"
    | "failed"
    | "cancelled"

/**
 * A job, as folded from its log.
 *
 * Nothing here is stored as a mutable field: every value is derived, so two
 * machines writing at once produce an ordering to resolve rather than a lost
 * write.
 */
export type Job = {
    id: string
    /** Short, human-typeable — what `axon job show 9c533cee` takes. */
    ref: string
    title: string
    content: string
    /** Who created it. The `author` every multi-user view will group by. */
    author: Actor
    /** Which machine created it, for the same reason. Null when it could not be identified. */
    machine: string | null
    /** Which machine is running it, once one has claimed. */
    claimedBy: string | null
    /** The agent to run, or null to take the configured default at claim time. */
    agent: string | null
    /** Where the work happens. Captured at creation — never inferred later. */
    cwd: string | null

    run: JobRun
    /** Whether a PERSON has marked it dealt with. The second axis. */
    acknowledged: boolean
    /** What the agent is waiting to be told, when blocked. */
    question: string | null
    /** The session of the agent run currently answering this, when there is one. */
    session: string | null

    createdAt: string
    updatedAt: string
    /** Every event, oldest first. The panel renders this; attach will stream it. */
    events: JobEvent[]
}

/** What the domain reports in one read. */
export type JobsState = {
    jobs: Job[]
    root: string
}
