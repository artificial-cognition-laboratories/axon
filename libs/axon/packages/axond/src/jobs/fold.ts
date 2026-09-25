import type { Job, JobEvent, JobRun, JobRunStatus, JobSchedule } from "./types"

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

    let acknowledged = false
    let updatedAt = created.at
    let brief = created.brief
    let title = created.title
    let schedule: JobSchedule | null = null
    const runs = new Map<string, JobRun>()
    let current: string | null = null

    for (const event of sorted) {
        updatedAt = event.at
        switch (event.kind) {
            case "brief.updated":
                brief = event.brief
                break
            case "title.updated":
                title = event.title
                break
            case "claimed": {
                const run: JobRun = {
                    id: event.run,
                    trigger: event.trigger,
                    status: "claimed",
                    machine: event.machine,
                    session: null,
                    question: null,
                    summary: null,
                    outcome: null,
                    decision: null,
                    changes: null,
                    check: null,
                    reason: null,
                    claimedAt: event.at,
                    startedAt: null,
                    finishedAt: null,
                }
                runs.set(run.id, run)
                current = run.id
                break
            }
            case "started":
                update(runs, event.run, { status: "running", session: event.session, startedAt: event.at })
                current = event.run
                break
            case "blocked":
                update(runs, event.run, { status: "blocked", question: event.question })
                current = event.run
                break
            case "said":
                // Answering unblocks it. The agent is waiting on a person, and
                // the reply IS the thing it was waiting for.
                if (current !== null && event.by.kind === "human") {
                    const run = runs.get(current)
                    if (run?.status === "blocked") update(runs, current, { status: "running", question: null })
                }
                break
            case "finished":
                update(runs, event.run, { status: "finished", summary: event.summary, outcome: event.outcome ?? "report", changes: event.changes ?? null, check: event.check ?? null, question: null, finishedAt: event.at })
                break
            case "failed":
                update(runs, event.run, { status: "failed", reason: event.reason, question: null, finishedAt: event.at })
                break
            case "cancelled":
                update(runs, event.run, { status: "cancelled", question: null, finishedAt: event.at })
                break
            case "decided":
                update(runs, event.run, { decision: event.verdict })
                break
            case "acknowledged":
                acknowledged = true
                break
            case "reopened":
                acknowledged = false
                break
            case "schedule.configured":
                schedule = event.schedule
                break
            case "schedule.paused":
                if (schedule !== null) {
                    const active: JobSchedule = schedule
                    schedule = { ...active, paused: true }
                }
                break
            case "schedule.resumed":
                if (schedule !== null) {
                    const active: JobSchedule = schedule
                    schedule = { ...active, paused: false }
                }
                break
        }
    }

    const history = [...runs.values()]
    const lastScheduled = [...history].reverse().find(entry => entry.trigger === "schedule")
    if (schedule !== null && lastScheduled !== undefined) {
        schedule = { ...schedule, lastRunAt: lastScheduled.claimedAt }
    }
    const run = current === null ? null : runs.get(current) ?? null
    return {
        id: id,
        ref: ref(id),
        workspace: created.workspace,
        title: title,
        brief: brief,
        author: created.by,
        machine: created.machine,
        claimedBy: run?.machine ?? null,
        agent: created.agent,
        cwd: created.cwd,
        paths: created.paths ?? [],
        run: run,
        runs: history,
        acknowledged: acknowledged,
        question: run?.question ?? null,
        session: run?.session ?? null,
        createdAt: created.at,
        updatedAt: updatedAt,
        events: sorted,
        schedule: schedule,
    }
}

/**
 * The short form a person types.
 *
 * A generated id is a UUID, and eight characters of one is plenty to pick it
 * out while staying typeable. A CHOSEN id is already the short form — someone
 * named it `auth-tokens` so they could type `auth-tokens`, and truncating that
 * to `auth-tok` would hand back a ref that is worse than the name they picked.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function ref(id: string): string {
    return UUID.test(id) ? id.slice(0, 8) : id
}

/** Whether a run has reached a state nothing should move it out of. */
export function terminal(run: JobRunStatus): boolean {
    return run === "finished" || run === "failed" || run === "cancelled"
}

/**
 * Whether a job still wants something to happen to it.
 *
 * What `axon job list` shows by default, and what a claiming daemon looks for.
 */
export function open(job: Job): boolean {
    // Acknowledgement settles it outright: it is a person saying they are done
    // with this, which is the whole meaning of the second axis. The old order
    // tested `run === null` first, so a job acknowledged before any agent ran
    // — filed, read, dismissed — stayed on the list forever.
    if (job.acknowledged) return false
    return job.run === null || !terminal(job.run.status)
}

function update(runs: Map<string, JobRun>, id: string, patch: Partial<Omit<JobRun, "id" | "trigger" | "machine" | "claimedAt">>): void {
    const run = runs.get(id)
    if (!run) throw new Error(`job event refers to unknown run ${id}`)
    runs.set(id, { ...run, ...patch })
}
