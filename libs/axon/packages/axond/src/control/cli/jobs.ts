import { header, rows, status } from "@arcforge/arcline"
import { Credential } from "../../agents/index"
import type { Actor } from "../../jobs/index"
import type { CliContext } from "./types"

/** JobCommands owns the jobs command surface. */
export function JobCommands(opts: CliContext) {
    const r = opts.renderer
    const credential = Credential({})
    const actor = (): Actor => credential.actor() ?? { kind: "agent", session: "anonymous" }

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
        async jobCreate(input: { brief: string; title?: string; agent?: string; cwd: string; id?: string; attach?: readonly string[] }, json = false): Promise<string> {
            const payload = {
                brief: input.brief,
                by: actor(),
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

        /** One job in full, with its thread. */
        async job(workspace: string, ref: string, json = false): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.at(ref)
            if (!job) return status(r, "info", "no such job", ref)
            if (json) return JSON.stringify(job)

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
                ...job.events.flatMap(event => {
                    const who = event.by.kind === "human" ? "you" : "agent"
                    const files = "attachments" in event && event.attachments?.length
                        ? [`         ${event.attachments.map(file => file.name).join(", ")}`]
                        : []
                    if (event.kind === "created") return [`  ${who}  ${event.brief}`, ...files]
                    if (event.kind === "brief.updated") return [`  ${who}  brief: ${event.brief}`, ...files]
                    if (event.kind === "said") return [`  ${who}  ${event.text}`, ...files]
                    if (event.kind === "blocked") return [`  agent  needs you: ${event.question}`]
                    if (event.kind === "failed") return [`  agent  failed: ${event.reason}`]
                    if (event.kind === "finished") {
                        const kind = event.outcome ?? "report"
                        return [`  agent  ${kind}: ${event.summary ?? "(no summary)"}`, ...files]
                    }
                    return []
                }),
            ].join("\n")
        },

        /** Add a turn. Answering a blocked job is what unblocks it. */
        async jobSay(workspace: string, ref: string, text: string, json = false, attach?: readonly string[]): Promise<string> {
            const input = { ref: ref, text: text, by: actor(), ...(attach !== undefined ? { attach: attach } : {}) }
            const job = opts.axond.workspaces.at(workspace).jobs.say(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "said", `${job.ref} · ${job.run?.status ?? "queued"}`)
        },

        /** Answer the run in progress with a report or proposal. */
        async jobAnswer(workspace: string, ref: string, outcome: "report" | "proposal", text: string, json = false, attach?: readonly string[]): Promise<string> {
            const input = { ref: ref, outcome: outcome, text: text, by: actor(), ...(attach !== undefined ? { attach: attach } : {}) }
            const job = opts.axond.workspaces.at(workspace).jobs.answer(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", outcome, `${job.ref} · ${job.run?.status ?? "queued"}`)
        },

        /** Replace the brief. The previous wording stays in the log. */
        async jobBrief(workspace: string, ref: string, brief: string, json = false, attach?: readonly string[]): Promise<string> {
            const input = { ref: ref, brief: brief, by: actor(), ...(attach !== undefined ? { attach: attach } : {}) }
            const job = opts.axond.workspaces.at(workspace).jobs.brief(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "brief updated", `${job.ref} · ${job.title}`)
        },

        /** Rename it. */
        async jobTitle(workspace: string, ref: string, title: string, json = false): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.title({ ref: ref, title: title, by: actor() })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "renamed", `${job.ref} · ${job.title}`)
        },

        /** Put it back on the list. A person's decision — an agent is refused. */
        async jobReopen(workspace: string, ref: string, json = false): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.reopen({ ref: ref, by: actor() })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "reopened", `${job.ref} · ${job.title}`)
        },

        /**
         * Give the job a recurring trigger, making it standing work.
         *
         * Not a second kind of job: the same job, with something other than a
         * person pulling the trigger.
         */
        async jobSchedule(workspace: string, ref: string, input: { every: string; agent: string; prompt: string; context?: "brief" | "recent" | "full" }, json = false): Promise<string> {
            const job = opts.axond.workspaces.at(workspace).jobs.configureSchedule({
                ref: ref,
                every: input.every,
                agent: input.agent,
                prompt: input.prompt,
                context: input.context ?? "brief",
                by: actor(),
            })
            if (json) return JSON.stringify(job)
            return status(r, "ok", "scheduled", `${job.ref} · ${job.schedule?.every ?? "-"} · ${job.schedule?.agent ?? "-"}`)
        },

        /** Suspend or resume the trigger without losing how it was set up. */
        async jobPause(workspace: string, ref: string, paused: boolean, json = false): Promise<string> {
            const jobs = opts.axond.workspaces.at(workspace).jobs
            const job = paused ? jobs.pauseSchedule({ ref: ref, by: actor() }) : jobs.resumeSchedule({ ref: ref, by: actor() })
            if (json) return JSON.stringify(job)
            return status(r, "ok", paused ? "paused" : "resumed", `${job.ref} · ${job.title}`)
        },

        /** Mark it dealt with. A person's decision — an agent is refused. */
        async jobDone(workspace: string, ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const job = opts.axond.workspaces.at(workspace).jobs.acknowledge(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "done", `${job.ref} · ${job.title}`)
        },

        /** Stop it. A person's decision — an agent is refused. */
        async jobCancel(workspace: string, ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const job = opts.axond.workspaces.at(workspace).jobs.cancel(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "cancelled", job.ref)
        },

        /** Run it again on the same thread. A person's decision — an agent is refused. */
        async jobRetry(workspace: string, ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const job = await opts.axond.workspaces.at(workspace).jobs.retry(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "retrying", `${job.ref} · ${job.run?.status ?? "queued"}`)
        },
    }
}

export type JobCommandsT = ReturnType<typeof JobCommands>
