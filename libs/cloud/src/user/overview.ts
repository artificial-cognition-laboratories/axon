import type { HttpClient } from "../platform/http"
import { num, record, rows, str } from "../platform/parse"

export type UptimePoint = { date: string; uptimePercent: number }
export type ErrorPoint = { date: string; errors: number }
export type ProfilePoint = { date: string; installs: number; stars: number }

export type OverviewStats = {
    uptime: UptimePoint[]
    errors: ErrorPoint[]
    profile: { daily: ProfilePoint[]; starsTotal: number; installsTotal: number }
    activeDeployments: number
    totalDeployments: number
}

function parse(raw: Record<string, unknown>): OverviewStats {
    const profile = record(raw.profile, "profile")
    return {
        uptime: rows(raw.uptime, "uptime").map(row => ({ date: str(row, "date"), uptimePercent: num(row, "uptimePercent") })),
        errors: rows(raw.errors, "errors").map(row => ({ date: str(row, "date"), errors: num(row, "errors") })),
        profile: {
            daily: rows(profile.daily, "profile.daily").map(row => ({ date: str(row, "date"), installs: num(row, "installs"), stars: num(row, "stars") })),
            starsTotal: num(profile, "starsTotal"),
            installsTotal: num(profile, "installsTotal"),
        },
        activeDeployments: num(raw, "activeDeployments"),
        totalDeployments: num(raw, "totalDeployments"),
    }
}

type OverviewOpts = {
    http: HttpClient
}

/**
 * The Overview page's one rich chart, in one call — uptime, errors, and
 * profile (stars/installs) rollups together so switching the chart's mode
 * client-side never re-fetches.
 */
export function Overview(opts: OverviewOpts) {
    return {
        async stats(input?: { days?: number }): Promise<OverviewStats> {
            const days = input?.days ?? 30
            const raw = await opts.http.get<Record<string, unknown>>(`/api/user/overview/stats?days=${days}`)
            return parse(raw)
        },
    }
}

export type OverviewHandle = ReturnType<typeof Overview>
