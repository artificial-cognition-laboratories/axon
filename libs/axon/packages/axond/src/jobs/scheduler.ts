import { nextRun } from "./cron"
import type { JobsT } from "./jobs"

type SchedulerOpts = {
    jobs: JobsT
    now?: () => number
}

/** Scheduler — wakes due work from one repository's job log. */
export function Scheduler(opts: SchedulerOpts) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const now = opts.now ?? (() => Date.now())

    function due(): number | null {
        const occurrences = opts.jobs.list()
            .map(job => job.schedule)
            .filter((schedule): schedule is NonNullable<typeof schedule> => schedule !== null && !schedule.paused)
            .map(schedule => nextRun(schedule.every, schedule.lastRunAt === null ? now() : Date.parse(schedule.lastRunAt)))
            .filter((at): at is number => at !== null)
        return occurrences.length === 0 ? null : Math.min(...occurrences)
    }

    async function tick(): Promise<void> {
        if (!running) return
        const current = now()
        for (const job of opts.jobs.list()) {
            const schedule = job.schedule
            if (schedule === null || schedule.paused) continue
            const expected = nextRun(schedule.every, schedule.lastRunAt === null ? current - 61_000 : Date.parse(schedule.lastRunAt))
            if (expected === null || expected > current) continue
            await opts.jobs.runScheduled(job.id)
        }
        arm()
    }

    function arm(): void {
        if (!running) return
        if (timer !== undefined) clearTimeout(timer)
        const occurrence = due()
        timer = setTimeout(() => { void tick() }, occurrence === null ? 60_000 : Math.max(250, occurrence - now()))
    }

    return {
        start(): void {
            if (running) return
            running = true
            arm()
        },
        stop(): void {
            running = false
            if (timer !== undefined) clearTimeout(timer)
            timer = undefined
        },
        tick: tick,
        next(): string | null {
            const occurrence = due()
            return occurrence === null ? null : new Date(occurrence).toISOString()
        },
    }
}

export type SchedulerT = ReturnType<typeof Scheduler>
