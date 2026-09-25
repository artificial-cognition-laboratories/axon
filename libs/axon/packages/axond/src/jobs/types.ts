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
 * A file carried by an event.
 *
 * ── Why this rides on an event rather than standing alone ───────────────────
 *
 * An attachment is evidence FOR a claim: the screenshot belongs to the report
 * that cites it, the recording belongs to the proposal it justifies. A
 * standalone `attached` event would be an orphan every reader has to re-pair
 * with nearby text by guessing, and every reader would guess differently.
 *
 * Evidence is also what makes a review cheap enough to do at fleet scale — a
 * proposal you can accept from a screenshot in seconds is a different product
 * from one that needs a diff read. So this is load-bearing, not decoration.
 *
 * `id` is the SHA-256 of the content, which is what makes the reference safe
 * in an append-only log: the same file attached twice is stored once, and a
 * reference can never come to mean different bytes later.
 */
export type Attachment = {
    /** SHA-256 of the content. The filename in the blob store. */
    id: string
    /** The name it had when it was attached, for display and for saving it back out. */
    name: string
    /** Media type, sniffed from the extension. `application/octet-stream` when unknown. */
    media: string
    bytes: number
}

/**
 * How an agent's run ended, when it ended by producing something.
 *
 * Exactly two, and the closed set is the point: a `proposal` sets out a change
 * in detail and is waiting for sign-off, a `report` states what happened —
 * work completed, scope found to be wrong, or a blocker the run could not get
 * past. Only a proposal can be approved, which is what makes the review
 * surface active rather than a list of things to read.
 *
 * Distinct from the `blocked` event, which is a run PAUSING mid-flight and
 * resuming when a person answers. A report about a blocker is terminal: that
 * run is over and the next step is a new one.
 */
export type JobRunOutcome = "proposal" | "report"

/**
 * What a person decided about a run's outcome.
 *
 * `changes` is not rejection: the work stands, it needs another pass, and the
 * comments left against it are the instruction. Rejection is for a line of
 * work that was wrong to begin with.
 */
export type JobVerdict = "accepted" | "changes" | "rejected"

/**
 * Whether the condition a standing job maintains still held on this run.
 *
 * Only recurring work sets it, and it is what makes an unbounded history
 * readable: a check that fires daily is mostly a run of identical passes, and
 * twelve of those are one line — "held, 3–14 Jan" — while the breach between
 * them is the thing worth a paragraph. Without it every surface has to guess
 * from prose whether a run found anything, which is exactly the guess that
 * turns a wall of reports into something nobody reads.
 */
export type JobCheck = "held" | "breached"

/**
 * One file a run touched, with the content on both sides.
 *
 * `before` and `after` are blob ids, so a diff can be RENDERED without the
 * working tree still being in that state — which it will not be, because the
 * next run moves it. A diff you can only see while the agent is still alive is
 * a diff you cannot review at your own pace, and reviewing at your own pace is
 * the entire point of doing this asynchronously.
 *
 * `before` is absent for a new file and `after` for a deleted one.
 */
export type ChangedFile = {
    path: string
    before: string | null
    after: string | null
    added: number
    removed: number
}

/**
 * What a run actually changed, as something a person can open.
 *
 * Until this existed a proposal's diff was a fenced code block — prose shaped
 * like a diff. Nothing could open it in a diff editor, and accepting could
 * only ever append a note to a log rather than apply anything.
 *
 * `head` is where the work is. A run gets its own worktree so that fifteen
 * jobs can be in flight without fighting over one checkout; once it ends, the
 * worktree can go and the branch is what remains.
 */
export type ChangeSet = {
    /** The ref this was branched from. */
    base: string
    /** The branch holding the work. */
    head: string
    /** The worktree it ran in, while one exists. */
    worktree?: string | null
    files: ChangedFile[]
}

/**
 * One thing that happened to a job.
 *
 * The log is APPEND-ONLY and state is folded from it — see `fold`. That is a
 * deliberate bet on the multi-machine case: many writers appending is an
 * ordering question with an answer, while many writers SETTING a status field
 * is data loss. It costs nothing locally, where there is one writer.
 */
/**
 * Events written by one action, grouped.
 *
 * The log records INTENT, not interaction. One ⌘S that changes a title, a
 * brief and a cadence is one decision, and rendering it as three rows made the
 * history mostly noise about how a form was operated — which is the append-only
 * design meeting an interactive surface, and the wrong half winning.
 *
 * Grouping rather than merging keeps what each event carries: the brief's
 * previous wording is still its own record, and a comment anchored to it still
 * resolves. Only the rendering folds.
 */
export type Batched = { batch?: string }

export type JobEvent =
    | { kind: "created"; at: string; by: Actor; machine: string | null; workspace: string; title: string; brief: string; agent: string | null; cwd: string | null; attachments?: Attachment[]; paths?: string[] }
    /** The brief is mutable state represented honestly as an event. */
    | { kind: "brief.updated"; at: string; by: Actor; batch?: string; brief: string; attachments?: Attachment[] }
    /**
     * Renaming.
     *
     * Separate from `brief.updated` because they change at different rates and
     * for different reasons: a brief is rewritten as understanding moves, a
     * title is corrected once when the first guess read badly in a list.
     */
    | { kind: "title.updated"; at: string; by: Actor; batch?: string; title: string }
    /** A machine took the work. Carries the lease so a stalled claim can be seen. */
    | { kind: "claimed"; at: string; by: Actor; run: string; trigger: JobRunTrigger; machine: string; until: string }
    | { kind: "started"; at: string; by: Actor; run: string; session: string }
    /**
     * A remark. Optionally ABOUT something, rather than merely after it.
     *
     * A chat's references are positional — "it" means the thing above — which
     * works while you are in the conversation and fails on every return visit,
     * and fails completely once two runs have answered the same question. An
     * anchor carries its referent, so a remark still means something in a
     * month.
     *
     * Anchors name a RUN rather than a position, because a run is immutable
     * and identified once it exists, while positions shift as a log grows.
     */
    | { kind: "said"; at: string; by: Actor; text: string; attachments?: Attachment[]; anchor?: { run: string; quote?: string } }
    /**
     * A person's verdict on what a run produced.
     *
     * First-class because it is the primary act of the whole surface: the
     * common path through a job is reading an outcome and clicking once. As an
     * ordinary remark ("yes, do it") a decision was indistinguishable from
     * commentary, so nothing could report what was actually waiting on a
     * person — and nothing linked an implementation back to the proposal that
     * authorised it.
     */
    | { kind: "decided"; at: string; by: Actor; run: string; verdict: JobVerdict }
    /** The agent needs a person. `question` is what to show in "Needs you". */
    | { kind: "blocked"; at: string; by: Actor; run: string; question: string }
    | { kind: "finished"; at: string; by: Actor; run: string; summary: string | null; outcome?: JobRunOutcome; attachments?: Attachment[]; changes?: ChangeSet; check?: JobCheck }
    | { kind: "failed"; at: string; by: Actor; run: string; reason: string }
    | { kind: "cancelled"; at: string; by: Actor; run: string }
    /** The PERSON marking it dealt with. Never the agent — see Actor. */
    | { kind: "acknowledged"; at: string; by: Actor }
    | { kind: "reopened"; at: string; by: Actor }
    /** A recurring trigger belongs to the job it wakes, not to an agent. */
    | { kind: "schedule.configured"; at: string; by: Actor; batch?: string; schedule: JobSchedule }
    | { kind: "schedule.paused"; at: string; by: Actor; batch?: string }
    | { kind: "schedule.resumed"; at: string; by: Actor; batch?: string }

/** The trigger attached to one scheduled job. Its runs remain ordinary job events. */
export type JobSchedule = {
    /** Standard five-field cron. The only thing a trigger genuinely needs. */
    every: string
    /**
     * An agent, only when it should differ from the job's own.
     *
     * Normally null. A job already names the agent that works it, and asking
     * again on the trigger was a second place for the same fact to live — and
     * the place that silently won, so changing the job's agent did nothing to
     * its nightly run.
     */
    agent: string | null
    /**
     * A named prompt, only when the brief is not the instruction.
     *
     * Normally null, because the brief IS what a standing job asks for, and
     * extra instruction belongs attached to the brief where a person can read
     * it next to the thing it qualifies. A prompt named here is invisible from
     * the job and drifts from the brief it is meant to serve.
     */
    prompt: string | null
    /**
     * How much of the job a run is told about. `brief` unless stated.
     *
     * The default is what keeps a loop affordable: "is coverage above 80%
     * today" does not depend on what it was three weeks ago, so sending the
     * whole log would grow every run's cost forever for nothing.
     */
    context: "brief" | "recent" | "full"
    paused: boolean
    lastRunAt: string | null
}

/**
 * How the agent's run is going.
 *
 * Deliberately separate from whether the PERSON is done with it. Collapsing
 * the two means either the agent gets to clear your list or you cannot clear
 * it yourself — see `Job.acknowledged`.
 */
export type JobRunStatus =
    | "queued"
    | "claimed"
    | "running"
    | "blocked"
    | "finished"
    | "failed"
    | "cancelled"

/** Why one attempt began. A recurring trigger must be visible in its history. */
export type JobRunTrigger = "manual" | "schedule"

/** One immutable attempt to do the work. `Job.runs` is the schedule history. */
export type JobRun = {
    id: string
    trigger: JobRunTrigger
    status: JobRunStatus
    machine: string | null
    session: string | null
    question: string | null
    summary: string | null
    /** What the run produced, when it finished. Null while it is still going. */
    outcome: JobRunOutcome | null
    /** What a person made of it. Null until somebody decides. */
    decision: JobVerdict | null
    /** What it changed, when it changed anything. */
    changes: ChangeSet | null
    /** Whether a standing job's condition held. Null for one-off work. */
    check: JobCheck | null
    reason: string | null
    claimedAt: string
    startedAt: string | null
    finishedAt: string | null
}

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
    /** Repository that owns this work and its `.agents/work` event stream. */
    workspace: string
    title: string
    /** Current folded brief. The original is retained in the created event. */
    brief: string
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
    /**
     * The part of the repository this job is about, as globs.
     *
     * Declared rather than derived, because the scope of a concern is a
     * judgement — "the billing totals" is not the set of files that happen to
     * have been edited. It is what lets a surface answer "what work touches
     * the file I am looking at", which is how a job stops being a panel beside
     * the editor and becomes part of it.
     */
    paths: string[]

    /** The attempt currently in progress, or the most recent completed one. */
    run: JobRun | null
    /** Every attempt, oldest first. Scheduled work renders these as its run log. */
    runs: JobRun[]
    /** Whether a PERSON has marked it dealt with. The second axis. */
    acknowledged: boolean
    /** What the latest agent attempt is waiting to be told, when blocked. */
    question: string | null
    /** The session of the agent run currently answering this, when there is one. */
    session: string | null

    createdAt: string
    updatedAt: string
    /** Every event, oldest first. The panel renders this; attach will stream it. */
    events: JobEvent[]
    /** Null for ordinary work; populated by schedule events for recurring work. */
    schedule: JobSchedule | null
}

/** What the domain reports in one read. */
export type JobsState = {
    jobs: Job[]
    root: string
}
