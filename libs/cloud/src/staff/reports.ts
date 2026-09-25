import type { HttpClient } from "../platform/http"
import { bool, num, record, rows, str, strOrNull } from "../platform/parse"

/**
 * One GROUP of identical failures, not one occurrence.
 *
 * The backend collapses occurrences onto a fingerprint, so this is "what is
 * broken and how badly" rather than a log line. `sample` holds one
 * representative payload — individual occurrences are not retained.
 */
export type ReportGroup = {
    id: string
    fingerprint: string
    /** 'cloud' | 'runtime' | 'backend' — which side of the platform failed. */
    source: string
    /** errorMap code, null for raw HTTP/network failures that never had one. */
    code: string | null
    severity: string
    message: string
    /** Release of the newest occurrence — distinguishes "fixed" from "still happening". */
    release: string | null
    occurrences: number
    firstSeenAt: string
    lastSeenAt: string
    /** One representative occurrence: stack, frames, scrubbed context, cause, platform. */
    sample: Record<string, unknown>
    /** Current state. A recurrence clears this automatically. */
    resolvedAt: string | null
    /**
     * Ever marked fixed, RETAINED across a reopen.
     *
     * `resolvedAt` is the current state and a recurrence wipes it. This is what
     * distinguishes "back after I fixed it" — urgent — from "nobody has looked
     * at this yet". Carried on the list because that is where triage happens.
     */
    lastResolvedAt: string | null
}

/**
 * One group plus the SHAPE of its occurrences over time.
 *
 * `days` is raw (day, release, count) buckets rather than a chart-ready series:
 * two different charts are drawn from it — per day, and per release — and
 * pre-shaping for one would mean sending it twice or teaching the backend which
 * charts the page happens to render.
 *
 * Individual occurrences are still not retained. This is the shape, not a log.
 */
export type ReportGroupDetail = Omit<ReportGroup, "id"> & {
    days: Array<{ day: string; release: string; count: number }>
}

/**
 * Whether the ingest channel itself is working.
 *
 * Read alongside the groups because an empty list means one of two OPPOSITE
 * things — nothing is failing, or the thing that records failures is broken.
 * The previous Reporter was invisible for its entire existence precisely
 * because "no reports" rendered as good news.
 */
export type ReportHealth = {
    healthy: boolean
    lastError: { message: string; at: string } | null
}

export type ReportsResponse = {
    groups: ReportGroup[]
    health: ReportHealth
}

type ReportsOpts = {
    http: HttpClient
}

export function Reports(opts: ReportsOpts) {
    return {
        /** Open groups, most recently seen first. */
        async list(input?: { includeResolved?: boolean; limit?: number }): Promise<ReportsResponse> {
            const params = new URLSearchParams()
            if (input?.includeResolved) params.set("resolved", "true")
            if (input?.limit !== undefined) params.set("limit", String(input.limit))
            const query = params.toString()

            const raw = await opts.http.get<Record<string, unknown>>(
                `/api/staff/reports${query ? `?${query}` : ""}`,
            )

            const health = record(raw.health, "health")
            const lastErrorRaw = health.lastError

            return {
                groups: rows(raw.groups, "groups").map(row => ({
                    id: str(row, "id"),
                    fingerprint: str(row, "fingerprint"),
                    source: str(row, "source"),
                    code: strOrNull(row, "code"),
                    severity: str(row, "severity"),
                    message: str(row, "message"),
                    release: strOrNull(row, "release"),
                    occurrences: num(row, "occurrences"),
                    firstSeenAt: str(row, "firstSeenAt"),
                    lastSeenAt: str(row, "lastSeenAt"),
                    sample: (row.sample ?? {}) as Record<string, unknown>,
                    resolvedAt: strOrNull(row, "resolvedAt"),
                    lastResolvedAt: strOrNull(row, "lastResolvedAt"),
                })),
                health: {
                    healthy: bool(health, "healthy"),
                    lastError:
                        lastErrorRaw === null || lastErrorRaw === undefined
                            ? null
                            : {
                                  message: str(record(lastErrorRaw, "health.lastError"), "message"),
                                  at: str(record(lastErrorRaw, "health.lastError"), "at"),
                              },
                },
            }
        },

        /**
         * One group, with the buckets its charts are drawn from.
         *
         * Addressed by FINGERPRINT, which is the identity everywhere else in
         * this system — so the URL is shareable and survives a re-report.
         */
        async group(fingerprint: string): Promise<ReportGroupDetail> {
            const raw = await opts.http.get<Record<string, unknown>>(
                `/api/staff/reports/${encodeURIComponent(fingerprint)}`,
            )
            const group = record(raw.group, "group")

            return {
                fingerprint: str(group, "fingerprint"),
                source: str(group, "source"),
                code: strOrNull(group, "code"),
                severity: str(group, "severity"),
                message: str(group, "message"),
                release: strOrNull(group, "release"),
                occurrences: num(group, "occurrences"),
                firstSeenAt: str(group, "firstSeenAt"),
                lastSeenAt: str(group, "lastSeenAt"),
                sample: (group.sample ?? {}) as Record<string, unknown>,
                resolvedAt: strOrNull(group, "resolvedAt"),
                lastResolvedAt: strOrNull(group, "lastResolvedAt"),
                days: rows(group.days, "group.days").map(bucket => ({
                    day: str(bucket, "day"),
                    release: str(bucket, "release"),
                    count: num(bucket, "count"),
                })),
            }
        },

        /**
         * Mark a group handled, or reopen it.
         *
         * Resolving is a display decision, not a delete: a later occurrence
         * reopens the same group automatically, which is what makes a
         * regression legible rather than looking like a brand-new failure.
         */
        async resolve(fingerprint: string, resolved: boolean): Promise<void> {
            await opts.http.patch(`/api/staff/reports/${encodeURIComponent(fingerprint)}`, { resolved })
        },
    }
}

export type ReportsHandle = ReturnType<typeof Reports>
