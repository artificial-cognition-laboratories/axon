import type { LauncherT } from "../launcher/index"
import type { Job } from "./types"

type RunnerOpts = {
    /** What boots the agent — the daemon's one launcher, shared with every other domain that boots agents. */
    launcher: LauncherT
    /** Report progress back onto the job's log. */
    report: {
        say(ref: string, text: string): void
        finish(ref: string, run: string, summary: string | null): void
        fail(ref: string, run: string, reason: string): void
    }
}

/** Runner — boots the agent that answers a job, and reports back. */
export function Runner(opts: RunnerOpts) {
    return {
        /**
         * Boot an agent for this job and deliver its instruction.
         *
         * Returns as soon as the agent is UP, not when it has answered. A job
         * is background work by definition — waiting here would tie its
         * lifetime to whatever called `create`, which is the property jobs
         * exist to remove. The answer arrives on the job's log.
         */
        async start(job: Job): Promise<{ session: string }> {
            const run = job.run
            if (run === null) throw new Error(`job ${job.ref} has no claimed run to start`)

            const schedule = job.schedule
            if (run.trigger === "schedule" && schedule === null) {
                throw new Error(`scheduled job ${job.ref} has no schedule configuration`)
            }
            // A trigger names an agent only when it should differ from the
            // job's own, so the job is the fallback rather than the exception.
            const scheduled = schedule !== null && run.trigger === "schedule" ? schedule.agent : null
            // Zeno is guaranteed to exist rather than assumed: a first-run
            // machine has no agents at all, and a job is the first thing this
            // user may ever run.
            const target = scheduled ?? job.agent ?? await opts.launcher.zeno()

            const agent = await opts.launcher.launch(target, { job: job.id })

            /*
             * Delivered WITHOUT awaiting, and its outcome reported onto the
             * log rather than thrown.
             *
             * `request` resolves when the model has finished thinking, which
             * for real work is minutes. The caller of `start` is a person who
             * has already walked away — the whole point — so the promise is
             * left running and its two endings both become events.
             */
            void agent.link
                .request({
                    type: "cognet:stimulus:text",
                    data: { content: instruction(job), channel: "axon-job" },
                } as never)
                .then((answer: unknown) => {
                    opts.report.finish(job.id, run.id, summaryOf(answer))
                })
                .catch((cause: unknown) => {
                    opts.report.fail(job.id, run.id, cause instanceof Error ? cause.message : String(cause))
                })

            return { session: agent.session }
        },
    }
}

export type RunnerT = ReturnType<typeof Runner>

/**
 * What the agent said, as one line for the job's log.
 *
 * Null when the answer has no text in it — a run whose whole output was tool
 * calls finished, and saying so with an empty string would look like it
 * returned nothing.
 */
function summaryOf(answer: unknown): string | null {
    if (typeof answer === "string" && answer.trim() !== "") return answer.trim()
    const content = (answer as { content?: unknown } | null)?.content
    if (typeof content === "string" && content.trim() !== "") return content.trim()
    return null
}

function instruction(job: Job): string {
    if (job.run?.trigger !== "schedule" || job.schedule === null) return job.brief
    return `${job.brief}\n\nScheduled run instruction:\n${job.schedule.prompt}`
}
