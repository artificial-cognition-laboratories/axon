import { tally } from "./tally"
import type { Summary } from "./types"

/**
 * Inference — the calls a mind made to its models over a session: how
 * often, how long each took, and how many were already under way when one
 * began.
 *
 * A call's duration is from asking to answer, so it includes waiting for
 * the worker. `busy` is each role's durations added up over the time
 * covered: one worker cannot be busier than 1, so a total above that is
 * calls waiting on each other — asking for more than there is.
 *
 * From the log, so it covers the whole session, not the telemetry window.
 */
export function Inference() {
    return {
        of(summary: Summary) {
            const counted = summary.log.inference
            const seconds = counted.firstMs !== null && counted.lastMs !== null ? (counted.lastMs - counted.firstMs) / 1000 : 0
            const roles = Object.entries(counted.roles)
                .map(([role, calls]) => ({
                    role: role,
                    calls: calls.count,
                    failed: calls.failed,
                    perSecond: seconds > 0 ? round(calls.count / seconds, 2) : null,
                    meanMs: tally.mean(calls),
                    p50Ms: tally.within(calls, 0.5),
                    p95Ms: tally.within(calls, 0.95),
                    maxMs: calls.maxMs,
                    busy: seconds > 0 ? round(calls.totalMs / 1000 / seconds, 2) : null,
                }))
                .sort((a, b) => (b.busy ?? 0) - (a.busy ?? 0))
            const begun = counted.behind.reduce((sum, count) => sum + count, 0)
            return {
                window: { fromMs: counted.firstMs, toMs: counted.lastMs, seconds: round(seconds, 1) },
                calls: begun,
                busy: seconds > 0 ? round(roles.reduce((sum, role) => sum + (role.busy ?? 0), 0), 2) : null,
                // Of the calls begun, how many found the worker free, and how many found others ahead.
                behind: counted.behind.map((count, already) => ({ already: already, calls: count })).filter(row => row.calls > 0),
                unanswered: Object.keys(counted.open).length,
                roles: roles,
            }
        },
    }
}

export type InferenceT = ReturnType<typeof Inference>

function round(value: number, places: number): number {
    const unit = 10 ** places
    return Math.round(value * unit) / unit
}
