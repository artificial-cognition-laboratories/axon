import { RepositoryJobs } from "./repository"
import { Scheduler } from "./scheduler"
import type { Job } from "./types"

type RepositoryWorkOpts = {
    workspace: string
    machineId?: () => string | null
    start?: (job: Job) => Promise<{ session: string }>
}

/** RepositoryWork — all work concerns for one checkout, with no global job store. */
export function RepositoryWork(opts: RepositoryWorkOpts) {
    const jobs = RepositoryJobs({
        workspace: opts.workspace,
        ...(opts.machineId ? { machineId: opts.machineId } : {}),
        ...(opts.start ? { start: opts.start } : {}),
    })
    const scheduler = Scheduler({ jobs: jobs })

    return {
        jobs: jobs,
        scheduler: scheduler,
    }
}

export type RepositoryWorkT = ReturnType<typeof RepositoryWork>
