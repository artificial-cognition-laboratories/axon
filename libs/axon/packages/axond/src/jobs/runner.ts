import { err } from "@arcforge/err"
import type { AgentsT } from "../agents/index"
import type { Job } from "./types"

type RunnerOpts = {
    /** Who supervises the boot. The daemon's own agents domain. */
    agents: AgentsT
    /** This build's version, for the platform it constructs. */
    version?: string
    /** Report progress back onto the job's log. */
    report: {
        say(ref: string, text: string): void
        finish(ref: string, summary: string | null): void
        fail(ref: string, reason: string): void
    }
}

/**
 * Runner — boots the agent that answers a job, and reports back.
 *
 * ── Why the daemon builds a Platform ────────────────────────────────────────
 *
 * Booting an agent needs a PREPARED blueprint, and preparing one — resolving
 * the reference, opening the project, installing, generating types — is the
 * platform's work and needs the whole project stack. The daemon deliberately
 * does not contain that.
 *
 * It does not have to. `Platform` takes a supervisor as a SEAM
 * (`InstancesOpts.daemon`, documented as "`Axond().agents` today"), so the
 * daemon can hold a platform purely as a blueprint builder and still be the
 * thing that owns the process. Platform builds; the daemon runs. That is the
 * direction those two files already describe, and nothing here inverts it.
 *
 * The alternative was for the CLI to prepare and hand the blueprint over. That
 * works for `axon job create` and fails for everything with no CLI standing by
 * — a retry, a boot-time job, a scheduled wake — which is the whole reason the
 * daemon exists.
 *
 * ── Lazy, and deliberately so ───────────────────────────────────────────────
 *
 * `Platform()` reads the store and the active profile at construction. A
 * daemon that built one at boot would fail to start on a machine nobody has
 * logged into, and would hold a profile captured before the user switched. It
 * is built on the first job that needs it.
 */
export function Runner(opts: RunnerOpts) {
    let platform: PlatformLike | null = null

    async function current(): Promise<PlatformLike> {
        if (platform) return platform
        // Imported here rather than at module scope: the daemon must be
        // constructible without the platform's whole dependency graph being
        // loaded, and every other consumer of this file pays that cost at
        // import time otherwise.
        const { Platform } = await import("@arcforge/platform")
        platform = Platform({
            version: opts.version ?? "0.0.0",
            // The seam. The daemon holds the credential and owns the process;
            // the platform only builds what gets booted.
            daemon: opts.agents as never,
        }) as unknown as PlatformLike
        return platform
    }

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
            const host = await current()

            const target = job.agent ?? host.agents.zeno.name
            // Zeno is guaranteed to exist rather than assumed: a first-run
            // machine has no agents at all, and a job is the first thing this
            // user may ever run.
            if (!job.agent) await host.agents.zeno.ensure()

            const project = await host.agents.resolve(target)
            const instance = await host.agents.spawn(project, { job: job.id })

            if (instance.source.kind !== "linked") {
                throw err("CLI_AGENT_NOT_LOCAL", {
                    detail: "a job needs an agent running on this machine, and the registry returned a remote one",
                    context: { job: job.ref, session: instance.sessionId },
                })
            }
            const agent = instance.source.agent

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
                    data: { content: job.content, channel: "axon-job" },
                } as never)
                .then((answer: unknown) => {
                    opts.report.finish(job.id, summaryOf(answer))
                })
                .catch((cause: unknown) => {
                    opts.report.fail(job.id, cause instanceof Error ? cause.message : String(cause))
                })

            return { session: instance.sessionId }
        },
    }
}

export type RunnerT = ReturnType<typeof Runner>

/**
 * Only the structure this file uses.
 *
 * Hand-written rather than imported from the platform, because importing its
 * types at module scope would pull the dependency this file loads lazily and
 * undo the reason it is lazy.
 */
type PlatformLike = {
    agents: {
        zeno: { name: string; ensure(): Promise<unknown> }
        resolve(ref: string): Promise<unknown>
        spawn(project: unknown, opts: { job?: string }): Promise<{
            sessionId: string
            source: { kind: string; agent: { link: { request(input: unknown): Promise<unknown> } } }
        }>
    }
}

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
