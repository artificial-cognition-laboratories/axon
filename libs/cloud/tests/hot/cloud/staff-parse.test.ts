import { describe, expect, test } from "bun:test"
import { Stats } from "../../../src/staff/stats"

/**
 * The dashboard client must survive an OLDER backend.
 *
 * Backend and web deploy independently. A parser that hard-requires a group
 * makes those two deploys lockstep — ship the dashboard first and every staff
 * page throws until the API catches up, turning one additive feature into a
 * coordinated release. That is exactly what the `cli` install group did before
 * these tests existed.
 */
function client(payload: Record<string, unknown>) {
    return Stats({
        http: {
            get: async () => payload,
        } as never,
    })
}

const SERIES = { dates: ["2026-09-01"], values: [1], total: 1, available: true }

const FULL = {
    range: "week",
    users: { cumulative: SERIES, active: SERIES },
    community: { installs: SERIES, stars: SERIES },
    failures: { cloud: SERIES, platform: SERIES },
    billing: { cumulative: SERIES, perBucket: SERIES },
}

describe("staff charts against an older backend", () => {
    test("a missing cli group parses as unavailable rather than throwing", async () => {
        const stats = await client(FULL).charts()
        expect(stats.cli.installs.available).toBe(false)
        expect(stats.cli.failures.available).toBe(false)
        // The groups that DID arrive are untouched.
        expect(stats.users.cumulative.available).toBe(true)
    })

    test("a present cli group is parsed normally", async () => {
        const stats = await client({ ...FULL, cli: { installs: SERIES, failures: SERIES } }).charts()
        expect(stats.cli.installs.available).toBe(true)
        expect(stats.cli.installs.total).toBe(1)
    })

    /**
     * Absence is tolerated; corruption is not. A group that arrives with the
     * wrong shape is a backend contract break, and swallowing it would hide a
     * real bug behind the same "not measured" stub used for an old deploy.
     */
    test("a MALFORMED cli group still throws", async () => {
        await expect(client({ ...FULL, cli: { installs: { dates: ["a"], values: [1, 2] }, failures: SERIES } }).charts())
            .rejects.toThrow()
    })
})

describe("staff lists against an older backend", () => {
    const LISTS = { users: [], transactions: [], failures: [] }

    test("missing installFailures and installHealth parse as empty and healthy", async () => {
        const lists = await client(LISTS).lists()
        expect(lists.installFailures).toEqual([])
        // Absent must not read as an outage — a red banner on every page until
        // the backend catches up would be a false alarm.
        expect(lists.installHealth.healthy).toBe(true)
    })

    test("a present installHealth is parsed normally", async () => {
        const lists = await client({ ...LISTS, installFailures: [], installHealth: { healthy: false, lastError: "sink down" } }).lists()
        expect(lists.installHealth.healthy).toBe(false)
        expect(lists.installHealth.lastError).toBe("sink down")
    })
})
