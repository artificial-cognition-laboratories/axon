import { err } from "@arcforge/err"

type ScheduleOpts = Record<string, never>

/**
 * Schedule — not wired yet.
 *
 * Boot-time agents and cron-style wakeups: the reason this is a daemon rather
 * than a library. Named now so it arrives as one of the four domains rather
 * than as a fifth concern bolted to the side once the others have shipped.
 */
export function Schedule(_opts: ScheduleOpts = {}) {
    return {
        state(): never {
            throw err("DAEMON_NOT_WIRED", { detail: "schedule is not wired yet" })
        },
    }
}

export type ScheduleT = ReturnType<typeof Schedule>
