import type { Job, JobEvent, JobRun } from "./types"

/**
 * Rebuild a job from its log.
 *
 * The single reason job state is never stored: this function is the only
 * definition of what a job IS, so a record on disk and a record synced from a
 * backend cannot disagree about it. Add an event kind, change this, and every
 * surface agrees at once.
 *
 * Events are folded in the order given. Out-of-order arrival is a real case
 * once several machines append — `sorted` puts them back in wall-clock order
 * first, which is a total order for a single job because the only concurrent
 * writers are a person and one claiming machine.
 */
export function fold(id: string, events: JobEvent[]): Job | null {
    const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at))
    const created = sorted.find(event => event.kind === "created")
    // A log with no creation is not an empty job, it is a broken one. Callers
    // skip it rather than rendering a row with no content — but nothing here
    // invents a title to make it look whole.
    if (!created) return null

    let run: JobRun = "queued"
    let acknowledged = false
    let question: string | null = null
    let session: string | null = null
    let claimedBy: string | null = null
    let updatedAt = created.at

    for (const event of sorted) {
        updatedAt = event.at
        switch (event.kind) {
            case "claimed":
                // Terminal states are not reopened by a late claim: a machine
                // that took a job which has since been cancelled elsewhere
                // must not resurrect it.
                if (!terminal(run)) run = "claimed"
                claimedBy = event.machine
                break
            case "started":
                session = event.session
                if (!terminal(run)) run = "running"
                break
            case "blocked":
                question = event.question
                if (!terminal(run)) run = "blocked"
                break
            case "said":
                // Answering unblocks it. The agent is waiting on a person, and
                // the reply IS the thing it was waiting for.
                if (run === "blocked" && event.by.kind === "human") {
                    run = "running"
                    question = null
                }
                break
            case "finished":
                run = "finished"
                question = null
                break
            case "failed":
                run = "failed"
                question = null
                break
            case "cancelled":
                run = "cancelled"
                question = null
                break
            case "acknowledged":
                acknowledged = true
                break
        }
    }

    return {
        id: id,
        ref: id.slice(0, 8),
        title: created.title,
        content: created.content,
        author: created.by,
        machine: created.machine,
        claimedBy: claimedBy,
        agent: created.agent,
        cwd: created.cwd,
        run: run,
        acknowledged: acknowledged,
        question: question,
        session: session,
        createdAt: created.at,
        updatedAt: updatedAt,
        events: sorted,
    }
}

/** Whether a run has reached a state nothing should move it out of. */
export function terminal(run: JobRun): boolean {
    return run === "finished" || run === "failed" || run === "cancelled"
}

/**
 * Whether a job still wants something to happen to it.
 *
 * What `axon job list` shows by default, and what a claiming daemon looks for.
 */
export function open(job: Job): boolean {
    return !terminal(job.run) || !job.acknowledged
}
