import { join } from "node:path"
import { Jobs, type JobsOpts } from "./jobs"
import type { Job } from "./types"

type RepositoryJobsOpts = {
    /** Repository root; job records travel with this checkout under .agents/work. */
    workspace: string
    machineId?: () => string | null
    start?: (job: Job) => Promise<{ session: string }>
}

/**
 * RepositoryJobs — the canonical work store for one checkout.
 *
 * The daemon may remember which repositories it serves, but their work is
 * deliberately not daemon-global: a job, its recurring trigger and its event
 * history are project context and live beside the project in version control.
 */
export function RepositoryJobs(opts: RepositoryJobsOpts) {
    const input: JobsOpts = {
        root: join(opts.workspace, ".agents", "work"),
        workspace: opts.workspace,
        ...(opts.machineId ? { machineId: opts.machineId } : {}),
        ...(opts.start ? { start: opts.start } : {}),
    }
    const jobs = Jobs(input)

    return jobs
}

export type RepositoryJobsT = ReturnType<typeof RepositoryJobs>
