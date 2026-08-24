import { createError } from "h3"
import type { AxonHandle, AxonSessionQuery, AxonSessionScope, AxonSessionSnapshot } from "@arcforge/types"

/**
 * SessionView — projecting the live session onto the wire.
 *
 * Owns one concern completely: turning an untrusted query string into a
 * bounded, cursor-carrying view of the session. Both read endpoints use it —
 * /_axon/session for the snapshot, /_axon/events for the same filters over
 * the replay — so the two can never disagree about what `since`, `limit` and
 * `include` mean.
 */

/** The three session views a client may ask for. Derived from nothing else — this IS the list. */
export const SCOPES: AxonSessionScope[] = ["entries", "log", "kernelLog"]

/**
 * Narrow untrusted query params into AxonSessionQuery at the boundary. A
 * malformed value is a 400 here rather than a surprise downstream — an
 * unparseable `since` silently treated as 0 would re-send the entire history
 * and look like duplicated messages in the client.
 */
export function parseQuery(raw: Record<string, unknown>): AxonSessionQuery {
    const query: AxonSessionQuery = {}

    for (const key of ["since", "limit"] as const) {
        const value = raw[key]
        if (value === undefined) continue
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0) {
            // `message`, not `statusMessage`: h3 will sanitize the latter, which
            // would strip the detail that makes a 400 actionable.
            throw createError({ statusCode: 400, message: `_axon/session: ${key} must be a non-negative integer` })
        }
        query[key] = parsed
    }

    if (raw.include !== undefined) {
        const names = String(raw.include).split(",").map(name => name.trim()).filter(Boolean)
        const invalid = names.filter(name => !SCOPES.includes(name as AxonSessionScope))
        if (invalid.length > 0) {
            throw createError({
                statusCode: 400,
                message: `_axon/session: unknown include "${invalid.join(", ")}" — expected ${SCOPES.join(", ")}`,
            })
        }
        query.include = names as AxonSessionScope[]
    }

    return query
}

/**
 * Build the wire snapshot from the live session.
 *
 * `since` filters on `time.seq` — the monotonic per-session counter — so a
 * client can ask for "everything after what I already have" and get an exact
 * delta rather than a best-effort time window. `limit` keeps the most recent
 * events and reports `truncated`, because a tail that claims to be a full
 * history is a lie the UI cannot detect.
 */
export function snapshot(axon: AxonHandle, query: AxonSessionQuery): AxonSessionSnapshot {
    const include = query.include ?? SCOPES
    // undefined (no since=) means "everything"; a NUMBER means "strictly after
    // that seq" — including since=0, which is a real cursor because the first
    // event of every session carries seq 0.
    const since = query.since
    const limit = query.limit

    function select<T extends { time: { seq: number } }>(source: readonly T[], scope: AxonSessionScope): { rows: T[]; capped: boolean } {
        if (!include.includes(scope)) return { rows: [], capped: false }
        const filtered = since === undefined ? [...source] : source.filter(event => event.time.seq > since)
        if (limit !== undefined && filtered.length > limit) {
            return { rows: filtered.slice(-limit), capped: true }
        }
        return { rows: filtered, capped: false }
    }

    const entries = select(axon.session.entries, "entries")
    const log = select(axon.session.log, "log")
    const kernelLog = select(axon.session.kernelLog, "kernelLog")

    // The cursor is the high-water mark across everything RETURNED, so a client
    // that omitted kernelLog does not skip past kernel events it never received.
    const cursor = Math.max(
        0,
        ...entries.rows.map(event => event.time.seq),
        ...log.rows.map(event => event.time.seq),
        ...kernelLog.rows.map(event => event.time.seq),
    )

    return {
        id: axon.session.id,
        entries: entries.rows,
        log: log.rows,
        kernelLog: kernelLog.rows,
        cursor,
        truncated: entries.capped || log.capped || kernelLog.capped,
    }
}
