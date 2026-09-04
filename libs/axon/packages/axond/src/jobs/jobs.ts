import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import { fold, open as isOpen, terminal } from "./fold"
import { Log, type LogT } from "./log"
import type { Actor, Job, JobEvent, JobsState } from "./types"

type JobsOpts = {
    /** Where job logs are written. */
    root: string
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
    async function start(ref: string): Promise<Job> {
        const job = need(ref)
        if (!opts.start) return job
        if (terminal(job.run) || job.session) return job

        const machine = opts.machineId?.() ?? "this machine"
        const actor: Actor = { kind: "agent", session: "daemon" }
        write(job.id, {
            kind: "claimed",
            at: new Date().toISOString(),
            by: actor,
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
                reason: cause instanceof Error ? cause.message : String(cause),
            })
        }
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
            content: string
            by: Actor
            title?: string
            agent?: string | null
            cwd?: string | null
        }): Promise<Job> {
            const content = String(input.content || "").trim()
            if (content === "") {
                throw err("JOB_NEEDS_CONTENT", {
                    detail: "a job with no instruction is not a job — say what to do",
                })
            }

            const id = randomUUID()
            write(id, {
                kind: "created",
                at: new Date().toISOString(),
                by: input.by,
                machine: opts.machineId?.() ?? null,
                title: input.title?.trim() || summarise(content),
                content: content,
                agent: input.agent ?? null,
                cwd: input.cwd ?? null,
            })

            return await start(id)
        },

        start: start,

        /**
         * Add a turn to the conversation.
         *
         * Open to both actors: the agent reports progress through this, and a
         * person answers a question with it. A human turn on a BLOCKED job is
         * what unblocks it — see `fold`.
         */
        say(input: { ref: string; text: string; by: Actor }): Job {
            const job = need(input.ref)
            const said = String(input.text || "").trim()
            if (said === "") {
                throw err("JOB_NEEDS_CONTENT", { detail: "nothing to say" })
            }
            write(job.id, { kind: "said", at: new Date().toISOString(), by: input.by, text: said })
            return need(job.id)
        },

        /** The agent reporting it needs a person. */
        block(input: { ref: string; question: string; by: Actor }): Job {
            const job = need(input.ref)
            write(job.id, {
                kind: "blocked",
                at: new Date().toISOString(),
                by: input.by,
                question: String(input.question || "").trim() || "waiting on you",
            })
            return need(job.id)
        },

        /** The agent's run could not be completed. Recorded, so `retry` has something to act on. */
        fail(input: { ref: string; reason: string; by: Actor }): Job {
            const job = need(input.ref)
            write(job.id, {
                kind: "failed",
                at: new Date().toISOString(),
                by: input.by,
                reason: String(input.reason || "").trim() || "unknown failure",
            })
            return need(job.id)
        },

        /** The agent reporting it is done. NOT the same as a person accepting it. */
        finish(input: { ref: string; summary?: string | null; by: Actor }): Job {
            const job = need(input.ref)
            write(job.id, {
                kind: "finished",
                at: new Date().toISOString(),
                by: input.by,
                summary: input.summary?.trim() || null,
            })
            return need(job.id)
        },

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

        /** Stop a job. A person's decision only — an agent must not abandon its own work. */
        cancel(input: { ref: string; by: Actor }): Job {
            humanOnly(input.by, "cancel")
            const job = need(input.ref)
            if (terminal(job.run)) return job
            write(job.id, { kind: "cancelled", at: new Date().toISOString(), by: input.by })
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
            if (!terminal(job.run)) {
                throw err("JOB_STILL_RUNNING", {
                    detail: `${job.ref} is ${job.run} — cancel it before retrying`,
                    context: { ref: job.ref, run: job.run },
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
function summarise(content: string): string {
    const line = content.split("\n").find(entry => entry.trim() !== "")?.trim() ?? content.trim()
    return line.length > 58 ? `${line.slice(0, 55)}…` : line
}
