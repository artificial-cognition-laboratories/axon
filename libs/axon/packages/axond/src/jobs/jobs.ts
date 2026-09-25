import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fold, open as isOpen, terminal } from "./fold"
import { Log, type LogT } from "./log"
import { isValidCron } from "./cron"
import { Blobs } from "./blobs"
import type { Actor, Attachment, ChangeSet, Job, JobCheck, JobEvent, JobRunOutcome, JobRunTrigger, JobSchedule, JobVerdict, JobsState } from "./types"

export type JobsOpts = {
    /** Where job logs are written. */
    root: string
    /** Repository that owns this store. Never infer it from a caller's cwd. */
    workspace: string
    /** This machine's id, read fresh per call. Null travels through — see Agents. */
    machineId?: () => string | null
    /**
     * Boot the agent that answers a job.
     *
     * A thunk handed in rather than a domain reached for: preparing a
     * blueprint needs the whole project stack and is the platform's work, so
     * the caller that HAS a platform supplies this. Absent, a job is created
     * and stays queued — which is a coherent state, and the honest one for a
     * daemon that cannot boot anything.
     */
    start?: (job: Job) => Promise<{ session: string }>
}

/**
 * Jobs — work delegated to an agent, and the record of what happened.
 *
 * ── The layer above agents ──────────────────────────────────────────────────
 *
 * An agent RUN is one attempt; a job is the thing you asked for. They are not
 * the same and the difference shows up on the second attempt: making the run
 * primary means a retry loses the thread you have been reading. `AgentRecord`
 * already carries `job` for exactly this correlation — this is the other end
 * of that link.
 *
 * ── Two axes, never one status ──────────────────────────────────────────────
 *
 * `run` is the agent's lifecycle and `acknowledged` is yours. Collapsed into
 * one field, either the agent clears your list or you cannot. The verbs split
 * the same way: an agent may report `finished`, only a person may
 * `acknowledge`.
 *
 * ── Nothing is stored but events ────────────────────────────────────────────
 *
 * Every read folds the log. See `fold` for why, and `Log` for why appending is
 * the shape that survives several machines writing.
 */
export function Jobs(opts: JobsOpts) {
    const log: LogT = Log({ root: opts.root })
    /**
     * Attachment storage, beside the logs rather than under each job.
     *
     * One store for the whole workspace, because content addressing dedupes
     * across jobs: the same screenshot cited by three jobs is one file.
     */
    const blobs = Blobs({ root: join(opts.root, "attachments") })

    /**
     * Resolve what an entry carries.
     *
     * Two arrivals, one store: `attach` names files on disk (the CLI's `-aa`),
     * `attachments` are descriptors for bytes already written (a paste from a
     * webview, which never had a path). Both end up as the same records.
     */
    function attach(files: readonly string[] | undefined, stored?: readonly Attachment[]): Attachment[] {
        return [...(files ?? []).map(file => blobs.add(file)), ...(stored ?? [])]
    }

    /** One job, folded, or null when there is no such log. */
    function at(ref: string): Job | null {
        const id = resolve(ref)
        if (!id) return null
        const { events } = log.read(id)
        return fold(id, events)
    }

    /**
     * Turn a short ref into a full id.
     *
     * Accepts either. Refuses an AMBIGUOUS prefix rather than picking one: two
     * jobs sharing eight hex characters is unlikely and cancelling the wrong
     * one is unrecoverable, so the rare case gets an error, not a coin toss.
     */
    function resolve(ref: string): string | null {
        const wanted = String(ref || "").trim()
        if (wanted === "") return null

        const ids = log.ids()
        if (ids.includes(wanted)) return wanted

        const matches = ids.filter(id => id.startsWith(wanted))
        if (matches.length === 1) return matches[0]!
        if (matches.length > 1) {
            throw err("JOB_REF_AMBIGUOUS", {
                detail: `${wanted} matches ${matches.length} jobs — use more of the id`,
                context: { ref: wanted, matches: matches.map(id => id.slice(0, 12)) },
            })
        }
        return null
    }

    /** The job named, or a loud failure. Every verb below takes a ref. */
    function need(ref: string): Job {
        const job = at(ref)
        if (!job) {
            throw err("JOB_NOT_FOUND", {
                detail: `no job matches ${ref}`,
                context: { ref: ref },
            })
        }
        return job
    }

    /**
     * Refuse a verb that belongs to a person.
     *
     * The reason `Actor` is not a string. An agent acknowledging its own work
     * would make the list meaningless — everything arrives already ticked off
     * by the thing that did it.
     */
    function humanOnly(actor: Actor, verb: string): void {
        if (actor.kind === "human") return
        throw err("JOB_NEEDS_A_PERSON", {
            detail: `${verb} is a person's decision — an agent cannot ${verb} a job`,
            context: { verb: verb, session: actor.session },
        })
    }

    function write(id: string, event: JobEvent): void {
        log.append(id, event)
    }

    /**
     * Every job, newest first. Damaged logs are skipped, never invented.
     *
     * A named closure rather than a method, because the handle is invoked
     * DETACHED: Dispatch path-walks to a verb and calls it, so `this` inside
     * one is undefined and a sibling reached through it throws. Every verb
     * another verb calls lives out here for that reason.
     */
    function list(): Job[] {
        const jobs: Job[] = []
        for (const id of log.ids()) {
            const folded = fold(id, log.read(id).events)
            if (folded) jobs.push(folded)
        }
        return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    /**
     * Claim a job for this machine and boot its agent.
     *
     * Separate from `create` because the two come apart the moment jobs are
     * shared: created on a laptop, claimed by whichever machine picks it up.
     * Locally there is one claimant and this is the same instant, which is
     * exactly when the seam is free to build. See `refresh` in Models on why
     * this is a closure.
     */
    async function start(ref: string, trigger: JobRunTrigger = "manual"): Promise<Job> {
        const job = need(ref)
        if (!opts.start) return job
        if (job.run !== null && !terminal(job.run.status)) return job

        const machine = opts.machineId?.() ?? "this machine"
        const actor: Actor = { kind: "agent", session: "daemon" }
        const run = randomUUID()
        write(job.id, {
            kind: "claimed",
            at: new Date().toISOString(),
            by: actor,
            run: run,
            trigger: trigger,
            machine: machine,
            // A lease, not a lock. Nothing enforces it locally — with one
            // daemon there is nothing to enforce against — but a shared job
            // needs to know when a claim went stale, and a claim recorded
            // without one can never expire.
            until: new Date(Date.now() + LEASE_MS).toISOString(),
        })

        try {
            const started = await opts.start(need(job.id))
            write(job.id, {
                kind: "started",
                at: new Date().toISOString(),
                by: actor,
                run: run,
                session: started.session,
            })
        } catch (cause) {
            // Recorded, not swallowed. The job carries why it could not start,
            // which is the thing the person needs — and `retry` is what acts
            // on it once the cause is fixed.
            write(job.id, {
                kind: "failed",
                at: new Date().toISOString(),
                by: actor,
                run: run,
                reason: cause instanceof Error ? cause.message : String(cause),
            })
        }
        return need(job.id)
    }

    /** The agent reporting it is done. NOT the same as a person accepting it. */
    function finish(input: { ref: string; run: string; summary?: string | null; outcome?: JobRunOutcome; by: Actor; attach?: readonly string[]; changes?: ChangeSet; check?: JobCheck }): Job {
        const job = need(input.ref)
        const files = attach(input.attach)
        write(job.id, {
            kind: "finished",
            at: new Date().toISOString(),
            by: input.by,
            run: input.run,
            summary: input.summary?.trim() || null,
            // `report` is the honest default: an agent that did not say it
            // was proposing was not proposing, and defaulting the other way
            // would put an Approve button on work already done.
            outcome: input.outcome ?? "report",
            ...(input.changes ? { changes: input.changes } : {}),
            ...(input.check ? { check: input.check } : {}),
            ...(files.length ? { attachments: files } : {}),
        })
        return need(job.id)
    }

    return {
        get root(): string {
            return log.root
        },

        /**
         * Everything the domain reports, newest first.
         *
         * Synchronous: it folds logs off disk, which a surface can afford per
         * render at the scale one person's jobs reach. When that stops being
         * true the answer is a cache in front of this, not a mutable state
         * field behind it.
         */
        state(): JobsState {
            return { jobs: list(), root: log.root }
        },

        list: list,

        /** Only what still wants something to happen. What `axon job list` shows. */
        open(): Job[] {
            return list().filter(isOpen)
        },

        at: at,

        /**
         * Create a job and try to start it.
         *
         * The start is attempted but not required: a daemon with no way to boot
         * an agent still records the work, and the job sits queued rather than
         * being refused. Losing what a person typed because nothing could run
         * it yet is the worse failure by a wide margin.
         */
        async create(input: {
            brief: string
            by: Actor
            title?: string
            agent?: string | null
            cwd?: string | null
            paths?: readonly string[]
            /**
             * A chosen id instead of a generated one.
             *
             * Set once, at creation, and never changed afterwards: the id is
             * the log's filename and the address every other surface holds
             * (Fleet's buffer URI is `<workspace>::<id>`), so renaming one
             * later orphans open buffers and any recorded cross-reference.
             * Choosing it up front is free; changing it never is.
             */
            id?: string
            attach?: readonly string[]
        }): Promise<Job> {
            /*
             * An empty brief is a DRAFT, not an error.
             *
             * This used to refuse, which was right when creating a job meant
             * dispatching an agent in the same breath. Creation now opens an
             * empty buffer to write in, and refusing that would mean typing
             * the brief somewhere else first — which is the cramped form in a
             * sidebar that the buffer replaced.
             *
             * What an empty brief does mean is that there is nothing to do
             * yet, so no run starts. Writing the brief is what sets it going.
             */
            const brief = String(input.brief || "").trim()

            const id = input.id === undefined ? randomUUID() : slug(input.id)
            if (input.id !== undefined && log.read(id).events.length > 0) {
                throw err("JOB_EXISTS", {
                    detail: `a job called ${id} is already here`,
                    context: { id: id },
                })
            }

            const files = attach(input.attach)
            write(id, {
                kind: "created",
                at: new Date().toISOString(),
                by: input.by,
                machine: opts.machineId?.() ?? null,
                workspace: opts.workspace,
                title: input.title?.trim() || (brief === "" ? "Untitled job" : summarise(brief)),
                brief: brief,
                agent: input.agent ?? null,
                cwd: input.cwd ?? null,
                ...(input.paths?.length ? { paths: [...input.paths] } : {}),
                ...(files.length ? { attachments: files } : {}),
            })

            // Nothing to ask an agent yet — see above.
            return brief === "" ? need(id) : await start(id)
        },

        start: start,

        /** The attachment store, for reading content back out by reference. */
        blobs: blobs,

        /**
         * Add a turn to the conversation.
         *
         * Open to both actors: the agent reports progress through this, and a
         * person answers a question with it. A human turn on a BLOCKED job is
         * what unblocks it — see `fold`.
         */
        say(input: { ref: string; text: string; by: Actor; attach?: readonly string[]; attachments?: readonly Attachment[]; anchor?: { run: string; quote?: string } }): Job {
            const job = need(input.ref)
            const said = String(input.text || "").trim()
            const files = attach(input.attach, input.attachments)
            // An attachment IS content. A screenshot with no covering sentence
            // is a normal thing to send, and refusing it would make the common
            // case — paste an image, say nothing — the one that fails.
            if (said === "" && files.length === 0) {
                throw err("JOB_NEEDS_CONTENT", { detail: "nothing to say" })
            }
            write(job.id, {
                kind: "said",
                at: new Date().toISOString(),
                by: input.by,
                text: said,
                ...(files.length ? { attachments: files } : {}),
                ...(input.anchor ? { anchor: input.anchor } : {}),
            })
            return need(job.id)
        },

        /** Replace the current brief while retaining the previous version in the event log. */
        brief(input: { ref: string; brief: string; by: Actor; attach?: readonly string[]; attachments?: readonly Attachment[]; batch?: string }): Job {
            const job = need(input.ref)
            const brief = String(input.brief || "").trim()
            if (brief === "") throw err("JOB_NEEDS_CONTENT", { detail: "a job brief cannot be empty" })
            const files = attach(input.attach, input.attachments)
            // Unchanged text with new evidence is still a change worth
            // recording — returning early would silently drop the files.
            if (brief === job.brief && files.length === 0) return job
            write(job.id, {
                kind: "brief.updated",
                at: new Date().toISOString(),
                by: input.by,
                brief: brief,
                ...(files.length ? { attachments: files } : {}),
                ...(input.batch ? { batch: input.batch } : {}),
            })
            return need(job.id)
        },

        /**
         * Record a verdict on a run's outcome. A person's decision only.
         *
         * Separate from acknowledging: a verdict is about one ATTEMPT, and a
         * job can outlive several. Accepting a proposal does not close the job
         * any more than merging one pull request closes an epic.
         */
        decide(input: { ref: string; run: string; verdict: JobVerdict; by: Actor }): Job {
            humanOnly(input.by, "decide on a run")
            const job = need(input.ref)
            if (!job.runs.some(attempt => attempt.id === input.run)) {
                throw err("JOB_NOT_FOUND", { detail: `job ${job.ref} has no run ${input.run}`, context: { run: input.run } })
            }
            write(job.id, { kind: "decided", at: new Date().toISOString(), by: input.by, run: input.run, verdict: input.verdict })
            return need(job.id)
        },

        /**
         * Delete a job and its whole history.
         *
         * Deliberately not a verb anything reaches for: acknowledging is how a
         * person clears their list, and that keeps the record. This is for
         * work that should never have been filed, and the confirmation belongs
         * to whoever asked rather than here.
         */
        destroy(ref: string): boolean {
            const job = at(ref)
            if (job === null) return false
            return log.destroy(job.id)
        },

        /** Rename the job. The brief says what the work is; this is only its label. */
        title(input: { ref: string; title: string; by: Actor; batch?: string }): Job {
            const job = need(input.ref)
            const title = String(input.title || "").trim()
            if (title === "") throw err("JOB_NEEDS_CONTENT", { detail: "a job title cannot be empty" })
            if (title === job.title) return job
            write(job.id, { kind: "title.updated", at: new Date().toISOString(), by: input.by, title: title, ...(input.batch ? { batch: input.batch } : {}) })
            return need(job.id)
        },

        /** Configure the one recurring trigger that makes this job scheduled work. */
        configureSchedule(input: { ref: string; every: string; agent?: string | null; prompt?: string | null; context?: JobSchedule["context"]; by: Actor; batch?: string }): Job {
            humanOnly(input.by, "configure a schedule")
            const job = need(input.ref)
            if (!isValidCron(input.every)) throw new Error("schedule cadence must be a five-field cron expression")
            const schedule: JobSchedule = {
                every: input.every,
                // Absent means "the job's own" and "the brief" — resolved at
                // fire time rather than copied here, so changing either on the
                // job actually changes what the trigger does.
                agent: input.agent?.trim() || null,
                prompt: input.prompt?.trim() || null,
                context: input.context ?? job.schedule?.context ?? "brief",
                paused: job.schedule?.paused ?? false,
                lastRunAt: job.schedule?.lastRunAt ?? null,
            }
            /*
             * Saving what is already saved writes nothing.
             *
             * Without this the log grew an event per keystroke-equivalent: the
             * panel saves a cadence the moment you pick one, and a preset you
             * click twice is not two decisions. An append-only log makes that
             * permanent, so the guard belongs at the write rather than in
             * every caller.
             */
            const current = job.schedule
            if (current
                && current.every === schedule.every
                && current.agent === schedule.agent
                && current.prompt === schedule.prompt
                && current.context === schedule.context) return job

            write(job.id, { kind: "schedule.configured", at: new Date().toISOString(), by: input.by, schedule: schedule, ...(input.batch ? { batch: input.batch } : {}) })
            return need(job.id)
        },

        pauseSchedule(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "pause a schedule")
            const job = need(input.ref)
            if (!job.schedule) throw new Error("job has no schedule")
            if (job.schedule.paused) return job
            write(job.id, { kind: "schedule.paused", at: new Date().toISOString(), by: input.by })
            return need(job.id)
        },

        resumeSchedule(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "resume a schedule")
            const job = need(input.ref)
            if (!job.schedule) throw new Error("job has no schedule")
            if (!job.schedule.paused) return job
            write(job.id, { kind: "schedule.resumed", at: new Date().toISOString(), by: input.by })
            return need(job.id)
        },

        /** Wake a due schedule. Only the scheduler calls this; people use `retry`. */
        async runScheduled(ref: string): Promise<Job> {
            const job = need(ref)
            if (job.schedule === null) throw new Error(`job ${job.ref} has no schedule`)
            if (job.schedule.paused) return job
            return await start(job.id, "schedule")
        },

        /** The agent reporting it needs a person. */
        block(input: { ref: string; run: string; question: string; by: Actor }): Job {
            const job = need(input.ref)
            write(job.id, {
                kind: "blocked",
                at: new Date().toISOString(),
                by: input.by,
                run: input.run,
                question: String(input.question || "").trim() || "waiting on you",
            })
            return need(job.id)
        },

        /** The agent's run could not be completed. Recorded, so `retry` has something to act on. */
        fail(input: { ref: string; run: string; reason: string; by: Actor }): Job {
            const job = need(input.ref)
            write(job.id, {
                kind: "failed",
                at: new Date().toISOString(),
                by: input.by,
                run: input.run,
                reason: String(input.reason || "").trim() || "unknown failure",
            })
            return need(job.id)
        },

        /**
         * Answer the run in progress with its outcome — `axon job <ref> -ar|-ap`.
         *
         * The agent records its own result, rather than whatever process
         * launched it relaying its last message: the relay loses the answer
         * whenever the launcher goes away mid-run, and a closing remark is
         * not the proposal. Finishing IS answering, so this is `finish` for
         * the current run — never a second, parallel record of outcome.
         */
        answer(input: { ref: string; outcome: JobRunOutcome; text: string; by: Actor; attach?: readonly string[] }): Job {
            const job = need(input.ref)
            const run = job.run
            if (!run || (run.status !== "claimed" && run.status !== "running" && run.status !== "blocked")) {
                throw err("JOB_NOT_RUNNING", { detail: `job ${job.ref} has no run in progress`, context: { status: run?.status ?? "none" } })
            }
            if (String(input.text || "").trim() === "") throw err("JOB_NEEDS_CONTENT", { detail: `an empty ${input.outcome} records nothing` })
            return finish({ ref: job.id, run: run.id, summary: input.text, outcome: input.outcome, by: input.by, ...(input.attach ? { attach: input.attach } : {}) })
        },

        /** The agent reporting it is done. NOT the same as a person accepting it. */
        finish: finish,

        /**
         * Mark a job dealt with. A person's decision only.
         *
         * The second axis, and the whole reason actors are typed.
         */
        acknowledge(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "acknowledge")
            const job = need(input.ref)
            if (job.acknowledged) return job
            write(job.id, { kind: "acknowledged", at: new Date().toISOString(), by: input.by })
            return need(job.id)
        },

        /** Put acknowledged work back on the active shelf without erasing its history. */
        reopen(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "reopen")
            const job = need(input.ref)
            if (!job.acknowledged) return job
            write(job.id, { kind: "reopened", at: new Date().toISOString(), by: input.by })
            return need(job.id)
        },

        /** Stop a job. A person's decision only — an agent must not abandon its own work. */
        cancel(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "cancel")
            const job = need(input.ref)
            if (job.run === null || terminal(job.run.status)) return job
            write(job.id, { kind: "cancelled", at: new Date().toISOString(), by: input.by, run: job.run.id })
            return need(job.id)
        },

        /**
         * Run it again, on the same thread.
         *
         * A new agent run against the SAME job, which is the whole reason the
         * job is the primitive: the conversation you have been reading
         * survives the retry.
         */
        async retry(input: { ref: string; by: Actor }): Promise<Job> {
            humanOnly(input.by, "retry")
            const job = need(input.ref)
            if (job.run !== null && !terminal(job.run.status)) {
                throw err("JOB_STILL_RUNNING", {
                    detail: `${job.ref} is ${job.run.status} — cancel it before retrying`,
                    context: { ref: job.ref, run: job.run.status },
                })
            }
            return await start(job.id)
        },
    }
}

export type JobsT = ReturnType<typeof Jobs>

/** How long a claim is good for. See the `claimed` event on why it exists locally. */
const LEASE_MS = 5 * 60_000

/**
 * A title from the instruction, when nobody gave one.
 *
 * `-t` is optional deliberately: the flow this exists for is typing one prompt
 * and thinking about nothing else, and a required title is friction on the one
 * path that has to be frictionless.
 */
/**
 * A chosen id, made safe to be a filename.
 *
 * Refused rather than mangled to nothing: an id that sanitises to empty is a
 * typo, and inventing a random one behind the user's back would file the job
 * somewhere they will not look for it.
 */
function slug(value: string): string {
    const clean = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64)
    if (clean === "") {
        throw err("JOB_ID_INVALID", {
            detail: `${value} has no characters usable in a name`,
            context: { id: value },
        })
    }
    return clean
}

function summarise(content: string): string {
    const line = content.split("\n").find(entry => entry.trim() !== "")?.trim() ?? content.trim()
    return line.length > 58 ? `${line.slice(0, 55)}…` : line
}
