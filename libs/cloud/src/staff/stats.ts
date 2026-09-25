import type { HttpClient } from "../platform/http"
import { bool, num, record, rows, str, strOrNull } from "../platform/parse"
import type { ActivityRange } from "../registry/registry"

/** One chart's series — a bucket-aligned grid the chart renders untouched. */
export type StaffSeries = {
    dates: string[]
    values: number[]
    /** The card's headline number — a total, not the last bucket. */
    total: number
    /**
     * False when nothing writes this metric yet. The card must render a stub
     * rather than a chart of zeros: "unmeasured" and "measured zero" are
     * different facts, and on a page for spotting breakage, showing the first
     * as the second is the exact failure it exists to prevent.
     */
    available: boolean
}

export type StaffStats = {
    range: ActivityRange
    users: { cumulative: StaffSeries; active: StaffSeries }
    /** REGISTRY artifact installs (a module added to a project) — not the CLI. See `cli`. */
    community: { installs: StaffSeries; stars: StaffSeries }
    failures: { cloud: StaffSeries; platform: StaffSeries }
    /**
     * The CLI install script's own outcomes — `curl … | bash` landing on a
     * machine, or failing to.
     *
     * Separate from `community.installs`, which counts a module being added to
     * a project. Two different events that share an English word; collapsing
     * them would make both numbers unreadable.
     */
    cli: { installs: StaffSeries; failures: StaffSeries }
    billing: { cumulative: StaffSeries; perBucket: StaffSeries }
}

/**
 * Where the newest evidence of a user came from. 'session' is the daily
 * activity metric, which covers both auth paths but only exists from
 * 2026-08-20; 'cli' is api_keys.last_used_at, which is CLI-only but reaches
 * back much further. The backend takes whichever is later — see Staff().
 */
export type LastSeenSource = "session" | "cli"

export type StaffUser = {
    id: string
    email: string
    username: string | null
    name: string | null
    avatarUrl: string | null
    isStaff: boolean
    createdAt: string
    active: boolean
    /**
     * When we last saw this user authenticate. Null means never — a real
     * fact, not a gap in the data: it is only null when BOTH sources are
     * empty, i.e. the account has never made an authenticated request.
     */
    lastSeenAt: string | null
    /** Null exactly when lastSeenAt is null. */
    lastSeenSource: LastSeenSource | null
}

export type StaffTransaction = {
    id: string
    kind: string
    status: string
    amountMinor: number
    currency: string
    description: string | null
    at: string
}

export type StaffFailure = {
    id: string
    subjectId: string
    subjectType: string
    message: string | null
    at: string
}

/**
 * One GROUP of identical install failures, not one occurrence.
 *
 * The grouping key is code + step + platform, because that is the unit a fix
 * addresses: "40 × BUN_EXEC_FAILED" is a shrug, "40 × BUN_EXEC_FAILED, all
 * alpine/musl" is a diagnosis. `machines` is carried alongside `count` since
 * one person retrying a broken install ten times is a very different fact
 * from ten people hitting it once.
 */
export type StaffInstallFailure = {
    id: string
    code: string | null
    step: string | null
    os: string | null
    distro: string | null
    libc: string | null
    axonVersion: string | null
    count: number
    machines: number
    /** Newest scrubbed detail in the group — usually the rest of the diagnosis. */
    sample: string | null
    at: string
}

export type StaffLists = {
    users: StaffUser[]
    transactions: StaffTransaction[]
    failures: StaffFailure[]
    installFailures: StaffInstallFailure[]
    /**
     * Whether the install-telemetry sink is recording.
     *
     * An empty installFailures list means one of two opposite things, and for
     * installs the ambiguity is worse than for crash reports: zero installs and
     * a dead ingest look identical, and "nobody is installing our product" is a
     * conclusion someone might believe.
     */
    installHealth: { healthy: boolean; lastError: string | null }
}

function series(raw: unknown, label: string): StaffSeries {
    const data = record(raw, label)
    const dates = data.dates
    const values = data.values
    if (!Array.isArray(dates) || !dates.every(d => typeof d === "string")) {
        throw new Error(`invalid response: ${label}.dates is not a string[]`)
    }
    if (!Array.isArray(values) || !values.every(v => typeof v === "number")) {
        throw new Error(`invalid response: ${label}.values is not a number[]`)
    }
    // A chart indexes labels and values together; a length mismatch would
    // silently label a bar with the wrong bucket's date.
    if (dates.length !== values.length) {
        throw new Error(`invalid response: ${label} has ${dates.length} dates but ${values.length} values`)
    }
    return { dates, values, total: num(data, "total"), available: bool(data, "available") }
}

/**
 * A series group the backend may not send yet.
 *
 * Two services deploy independently, so the client must survive meeting a
 * backend older than itself. Hard-requiring a group makes the two deploys
 * LOCKSTEP: ship the dashboard first and every staff page throws until the API
 * catches up, which turns one additive feature into a coordinated release.
 *
 * `available: false` already means exactly "this is not measured", and the page
 * already renders it as a stub rather than a chart of zeros — so an absent
 * group has a truthful representation that costs nothing to produce. A
 * MALFORMED group is still an error: `series()` throws on one, and only
 * complete absence is tolerated.
 */
function optionalSeries(raw: unknown, label: string): StaffSeries {
    if (raw === undefined || raw === null) return { dates: [], values: [], total: 0, available: false }
    return series(raw, label)
}

function parseStats(raw: Record<string, unknown>): StaffStats {
    const users = record(raw.users, "users")
    const community = record(raw.community, "community")
    const failures = record(raw.failures, "failures")
    // Optional: a backend that predates the cli group sends nothing here.
    const cli = (raw.cli ?? {}) as Record<string, unknown>
    const billing = record(raw.billing, "billing")
    return {
        range: str(raw, "range") as ActivityRange,
        users: { cumulative: series(users.cumulative, "users.cumulative"), active: series(users.active, "users.active") },
        community: { installs: series(community.installs, "community.installs"), stars: series(community.stars, "community.stars") },
        failures: { cloud: series(failures.cloud, "failures.cloud"), platform: series(failures.platform, "failures.platform") },
        cli: {
            installs: optionalSeries(cli.installs, "cli.installs"),
            failures: optionalSeries(cli.failures, "cli.failures"),
        },
        billing: { cumulative: series(billing.cumulative, "billing.cumulative"), perBucket: series(billing.perBucket, "billing.perBucket") },
    }
}

/**
 * Narrow the source string at the boundary rather than casting it. An
 * unknown value is a backend contract change, not something to pass through
 * to a component that switches on it.
 */
function lastSeenSource(row: Record<string, unknown>): LastSeenSource | null {
    const raw = strOrNull(row, "lastSeenSource")
    if (raw === null) return null
    if (raw !== "session" && raw !== "cli") {
        throw new Error(`invalid response: users[].lastSeenSource is "${raw}", expected "session" | "cli"`)
    }
    return raw
}

function parseLists(raw: Record<string, unknown>): StaffLists {
    return {
        users: rows(raw.users, "users").map(row => ({
            id: str(row, "id"),
            email: str(row, "email"),
            username: strOrNull(row, "username"),
            name: strOrNull(row, "name"),
            avatarUrl: strOrNull(row, "avatarUrl"),
            isStaff: bool(row, "isStaff"),
            createdAt: str(row, "createdAt"),
            active: bool(row, "active"),
            lastSeenAt: strOrNull(row, "lastSeenAt"),
            lastSeenSource: lastSeenSource(row),
        })),
        transactions: rows(raw.transactions, "transactions").map(row => ({
            id: str(row, "id"),
            kind: str(row, "kind"),
            status: str(row, "status"),
            amountMinor: num(row, "amountMinor"),
            currency: str(row, "currency"),
            description: strOrNull(row, "description"),
            at: str(row, "at"),
        })),
        failures: rows(raw.failures, "failures").map(row => ({
            id: str(row, "id"),
            subjectId: str(row, "subjectId"),
            subjectType: str(row, "subjectType"),
            message: strOrNull(row, "message"),
            at: str(row, "at"),
        })),
        // Same reasoning as optionalSeries: absent means an older backend, and
        // an empty list is the truthful rendering of "nothing reported here".
        installFailures: (raw.installFailures === undefined ? [] : rows(raw.installFailures, "installFailures")).map(row => ({
            id: str(row, "id"),
            code: strOrNull(row, "code"),
            step: strOrNull(row, "step"),
            os: strOrNull(row, "os"),
            distro: strOrNull(row, "distro"),
            libc: strOrNull(row, "libc"),
            axonVersion: strOrNull(row, "axonVersion"),
            count: num(row, "count"),
            machines: num(row, "machines"),
            sample: strOrNull(row, "sample"),
            at: str(row, "at"),
        })),
        /*
         * Absent reads as HEALTHY, not as broken.
         *
         * The honest default for "this backend does not report install health"
         * is not an alarm — a red banner on every page until the API catches up
         * would be a false alarm, and the list beside it is empty for the same
         * reason. Once the backend sends the field, a real outage shows.
         */
        installHealth: raw.installHealth === undefined
            ? { healthy: true, lastError: null }
            : {
                healthy: bool(record(raw.installHealth, "installHealth"), "healthy"),
                lastError: strOrNull(record(raw.installHealth, "installHealth"), "lastError"),
            },
    }
}

type StatsOpts = {
    http: HttpClient
}

/**
 * The staff dashboard's data. Two calls, split by lifetime: charts refetch
 * when the range changes, lists never do.
 */
export function Stats(opts: StatsOpts) {
    return {
        /** Every chart group for one range, in one call. */
        async charts(range: ActivityRange = "week"): Promise<StaffStats> {
            const raw = await opts.http.get<Record<string, unknown>>(`/api/staff/stats?range=${range}`)
            return parseStats(raw)
        },

        /** The users / transactions / failures tabs, in one call. */
        async lists(): Promise<StaffLists> {
            const raw = await opts.http.get<Record<string, unknown>>("/api/staff/lists")
            return parseLists(raw)
        },
    }
}

export type StatsHandle = ReturnType<typeof Stats>
