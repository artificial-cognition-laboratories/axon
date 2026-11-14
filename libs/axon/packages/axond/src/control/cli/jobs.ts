import { header, rows, status } from "@arcforge/arcline"
import { Credential } from "../../agents/index"
import type { Actor, JobEvent } from "../../jobs/index"
import type { CliContext } from "./types"

/** JobCommands owns the jobs command surface. */
export function JobCommands(opts: CliContext) {
    const r = opts.renderer
    const credential = Credential({})
    /**
     * Who is writing, by name when one is given.
     *
     * `--as` wins, then AXON_ACTOR. A name always records an AGENT: it is how a
     * worker running under someone's login says which worker it is, and it must
     * never confer what only the signed-in person may do — so `--as cody` cannot
     * close a job. Without a name nothing changes: a person stays a person.
     */
    const actor = (as?: string): Actor => {
        const signed = credential.actor()
        const name = (as ?? process.env.AXON_ACTOR ?? "").trim()
        if (name === "") return signed ?? { kind: "agent", session: "anonymous" }
        return { kind: "agent", session: signed?.kind === "agent" ? signed.session : name, name: name }
    }

    return {

        // ── Jobs ────────────────────────────────────────────────────────────

        /**
         * Delegate work to an agent.
         *
         * Through the RUNNING daemon whenever there is one, for the reason
         * `download` is: the agent this boots must outlive the command that
         * asked for it, and this process exits the moment the command returns.
         * Local is the honest fallback — the job is recorded and stays queued
         * until a daemon picks it up, which beats losing what a person typed
         * because nothing was listening.
         */
        async jobCreate(input: { brief: string; title?: string; agent?: string; cwd: string; id?: string; attach?: readonly string[]; as?: string }, json = false): Promise<string> {
            const payload = {
                brief: input.brief,
                by: actor(input.as),
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.agent !== undefined ? { agent: input.agent } : {}),
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                ...(input.id !== undefined ? { id: input.id } : {}),
                ...(input.attach !== undefined ? { attach: input.attach } : {}),
            }
            const job = await opts.axond.workspaces.at(input.cwd).jobs.create(payload)

            if (json) return JSON.stringify(job)
            return status(r, "ok", "job created", `${job.ref} · ${job.title}`)
        },

        /** Every job, or only the ones still wanting something. */
        async jobs(workspace: string, all = false, json = false): Promise<string> {
            const store = opts.axond.workspaces.at(workspace).jobs
            const jobs = all ? store.list() : store.open()

            if (json) return JSON.stringify({ jobs: jobs })
            if (jobs.length === 0) return status(r, "info", all ? "no jobs" : "nothing open", "`axon job create \"what needs doing\"`")

            return [
                header(r, { title: "jobs", subtitle: `${jobs.length}` }),
                "",
                ...rows(r, jobs.map(job => ({
                    label: `${job.ref}  ${job.title}`,
                    value: `${job.run?.status ?? "queued"}${job.acknowledged ? " · done" : ""}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /**
         * One job in full, with its thread.
         *
         * Every entry carries its `#seq` — its position in the append-only log,
         * which never changes once written — so a reader can come back with
         * `since` and see only what was added after the last entry it read.
         */
        async job(workspace: string, ref: string, json = false, since?: number): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.at(ref)
            if (!job) return status(r, "info", "no such job", ref)
            const entries = job.events.map((event, seq) => ({ seq: seq, event: event })).filter(entry => since === undefined || entry.seq > since)
            if (json) return JSON.stringify(since === undefined ? job : { ...job, events: entries.map(entry => ({ seq: entry.seq, ...entry.event })) })
            const thread = entries.flatMap(entry => line(entry.seq, entry.event))
            if (since !== undefined) return thread.length ? thread.join("\n") : status(r, "info", "nothing new", `${job.ref} · after #${since}`)

            return [
                header(r, { title: job.title, subtitle: `${job.ref} · ${job.run?.status ?? "queued"}${job.acknowledged ? " · done" : ""}` }),
                "",
                ...rows(r, [
                    { label: "agent", value: job.agent ?? "default", arrow: false },
                    { label: "where", value: job.cwd ?? "-", arrow: false },
                    { label: "session", value: job.session ?? "-", arrow: false },
                    ...(job.schedule ? [{ label: "every", value: `${job.schedule.every}${job.schedule.paused ? " (paused)" : ""}`, arrow: false }] : []),
                    ...(job.question ? [{ label: "waiting on", value: job.question, arrow: false }] : []),
                ]),
                "",
                /*
                 * The thread, including what runs produced.
                 *
                 * `finished` is shown because it is half the conversation: a
                 * proposal waiting for sign-off is the single most important
                 * line on the job, and filtering it out left `axon job <ref>`
                 * reporting a job where the agent had apparently said nothing.
                 */
                ...thread,
            ].join("\n")
        },

        /**
         * Append a note or a report to the log.
         *
         * Only ever a record: nothing here starts, resumes or claims a run. (A
         * person's note on a BLOCKED run still reads as the answer it was
         * waiting for — see `fold` — but that moves no process.)
         */
        async jobSay(workspace: string, ref: string, text: string, json = false, attach?: readonly string[], as?: string, entry: "note" | "report" = "note"): Promise<string> {
            const input = { ref: ref, text: text, by: actor(as), entry: entry, ...(attach !== undefined ? { attach: attach } : {}) }
            const job = opts.axond.workspaces.at(workspace).jobs.say(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", entry, `${job.ref} · #${job.events.length - 1}`)
        },

        /**
         * Answer with a report or proposal.
         *
         * A run in progress is finished by it, as before. With none, a report is
         * an ordinary report entry on the log — the common case now that most
         * work is done by a worker that is not an Axon run — while a proposal
         * still needs a run, because only a run's proposal can be decided on.
         */
        async jobAnswer(workspace: string, ref: string, outcome: "report" | "proposal", text: string, json = false, attach?: readonly string[], as?: string): Promise<string> {
            const jobs = opts.axond.workspaces.at(workspace).jobs
            const current = jobs.at(ref)?.run
            const running = current && (current.status === "claimed" || current.status === "running" || current.status === "blocked")
            if (!running && outcome === "report") {
                const job = jobs.say({ ref: ref, text: text, by: actor(as), entry: "report", ...(attach !== undefined ? { attach: attach } : {}) })
                if (json) return JSON.stringify(job)
                return status(r, "ok", "report", `${job.ref} · #${job.events.length - 1}`)
            }
            const input = { ref: ref, outcome: outcome, text: text, by: actor(as), ...(attach !== undefined ? { attach: attach } : {}) }
            const job = jobs.answer(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", outcome, `${job.ref} · ${job.run?.status ?? "queued"}`)
        },

        /** Replace the brief. The previous wording stays in the log. */
        async jobBrief(workspace: string, ref: string, brief: string, json = false, attach?: readonly string[], as?: string): Promise<string> {
            const input = { ref: ref, brief: brief, by: actor(as), ...(attach !== undefined ? { attach: attach } : {}) }
            const job = opts.axond.workspaces.at(workspace).jobs.brief(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "brief updated", `${job.ref} · ${job.title}`)
        },

        /** Rename it. */
        async jobTitle(workspace: string, ref: string, title: string, json = false, as?: string): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.title({ ref: ref, title: title, by: actor(as) })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "renamed", `${job.ref} · ${job.title}`)
        },

        /** Put it back on the list. A person's decision — an agent is refused. */
        async jobReopen(workspace: string, ref: string, json = false, as?: string): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.reopen({ ref: ref, by: actor(as) })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "reopened", `${job.ref} · ${job.title}`)
        },

        /**
         * Give the job a recurring trigger, making it standing work.
         *
         * Not a second kind of job: the same job, with something other than a
         * person pulling the trigger.
         */
        async jobSchedule(workspace: string, ref: string, input: { every: string; agent: string; prompt: string; context?: "brief" | "recent" | "full" }, json = false, as?: string): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.configureSchedule({
                ref: ref,
                every: input.every,
                agent: input.agent,
                prompt: input.prompt,
                context: input.context ?? "brief",
                by: actor(as),
            })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "scheduled", `${job.ref} · ${job.schedule?.every ?? "-"} · ${job.schedule?.agent ?? "-"}`)
        },

        /** Suspend or resume the trigger without losing how it was set up. */
        async jobPause(workspace: string, ref: string, paused: boolean, json = false, as?: string): Promise<string> {
            const jobs = opts.axond.workspaces.at(workspace).jobs
            const job = paused ? jobs.pauseSchedule({ ref: ref, by: actor(as) }) : jobs.resumeSchedule({ ref: ref, by: actor(as) })
            if (json) return JSON.stringify(job)
            return status(r, "ok", paused ? "paused" : "resumed", `${job.ref} · ${job.title}`)
        },

        /** Mark it dealt with. A person's decision — an agent is refused. */
        async jobDone(workspace: string, ref: string, json = false, as?: string): Promise<string> {
            const input = { ref: ref, by: actor(as) }
            const job = opts.axond.workspaces.at(workspace).jobs.acknowledge(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "done", `${job.ref} · ${job.title}`)
        },

        /** Stop it. A person's decision — an agent is refused. */
        async jobCancel(workspace: string, ref: string, json = false, as?: string): Promise<string> {
            const input = { ref: ref, by: actor(as) }
            const job = opts.axond.workspaces.at(workspace).jobs.cancel(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "cancelled", job.ref)
        },

        /** Run it again on the same thread. A person's decision — an agent is refused. */
        async jobRetry(workspace: string, ref: string, json = false, as?: string): Promise<string> {
            const input = { ref: ref, by: actor(as) }
            const job = await opts.axond.workspaces.at(workspace).jobs.retry(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "retrying", `${job.ref} · ${job.run?.status ?? "queued"}`)
        },
    }
}

/** Who wrote an entry, as a reader recognises them. */
export function author(by: Actor): string {
    if (by.kind === "human") return by.account
    return by.name ?? (by.session === "anonymous" ? "agent" : `agent ${by.session.slice(0, 8)}`)
}

/**
 * One log entry as lines, or none for bookkeeping a reader does not need.
 *
 * `finished` is shown because it is half the conversation: a proposal waiting
 * for sign-off is the single most important line on the job, and filtering it
 * out left `axon job <ref>` reporting a job where the agent had apparently
 * said nothing.
 */
function line(seq: number, event: JobEvent): string[] {
    const head = `  #${seq}  ${author(event.by)}`
    const files = "attachments" in event && event.attachments?.length
        ? [`         ${event.attachments.map(file => file.name).join(", ")}`]
        : []
    if (event.kind === "created") return [`${head}  ${event.brief}`, ...files]
    if (event.kind === "brief.updated") return [`${head}  brief: ${event.brief}`, ...files]
    if (event.kind === "said") return [`${head}  ${event.entry === "report" ? "report: " : ""}${event.text}`, ...files]
    if (event.kind === "blocked") return [`${head}  needs you: ${event.question}`]
    if (event.kind === "failed") return [`${head}  failed: ${event.reason}`]
    if (event.kind === "finished") return [`${head}  ${event.outcome ?? "report"}: ${event.summary ?? "(no summary)"}`, ...files]
    return []
}

export type JobCommandsT = ReturnType<typeof JobCommands>
