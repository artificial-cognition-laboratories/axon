import { describe, expect, it } from "bun:test"
import { AxonCloud } from "../../../src"
import { Reporting } from "../../../src/platform/reporting"
import { backendUrl } from "../../full/setup/staging"
import { TEST_USER } from "../../full/setup/user"

/**
 * The shape a crash group has over time, and the memory of having been fixed.
 *
 * These are the two things the error detail page is built on, and neither can
 * be reconstructed after the fact: a day bucket not written when the occurrence
 * arrived is gone forever, and `resolvedAt` is cleared by the very recurrence
 * that makes a regression worth seeing.
 *
 * Over the wire against real staging, because the rollup is an upsert with a
 * three-column key — exactly the kind of thing that typechecks and then fails
 * to conflict against a real index, producing one bar per occurrence instead of
 * one bar per day.
 */

const baseUrl = backendUrl()
const staff = () => AxonCloud({ baseUrl, key: TEST_USER.apiKey }).staff.reports

/**
 * One occurrence, from a FRESH Reporting instance every time.
 *
 * `Reporting` deduplicates per instance — an identical failure is sent once per
 * process, deliberately, so a loop that throws the same error a thousand times
 * spends one request. A single instance therefore cannot produce a second
 * occurrence however many times it is called, and a test reusing one would be
 * asserting against the client's dedup rather than the server's rollup.
 *
 * It also names what `occurrences` actually counts: distinct reporting
 * SESSIONS, not raw throws. That is the honest reading of the per-day chart.
 *
 * The fingerprint includes the release, so a unique release isolates this run.
 */
async function occurrence(release: string): Promise<void> {
    const reporting = Reporting({ baseUrl, release, platform: "bun-test/linux" })
    reporting.send({
        source: "runtime",
        code: "AX-TEST-SHAPE",
        message: "Rollup fixture",
        severity: "fatal",
        stack: "Error: Rollup fixture\n    at fixture (/app/fixture.ts:1:1)",
    })
    await reporting.flush()
}

/** Poll the detail until `predicate` holds — `send()` is fire-and-forget. */
async function until(fingerprint: string, predicate: (group: Awaited<ReturnType<ReturnType<typeof staff>["group"]>>) => boolean) {
    const deadline = Date.now() + 5_000
    let latest = await staff().group(fingerprint)
    while (Date.now() < deadline) {
        if (predicate(latest)) return latest
        await Bun.sleep(100)
        latest = await staff().group(fingerprint)
    }
    return latest
}

/** The group for `release`, once ingest has caught up. */
async function groupFor(release: string) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        const found = (await staff().list({ includeResolved: true, limit: 500 }))
            .groups.find(group => group.release === release)
        if (found) return found
        await Bun.sleep(50)
    }
    throw new Error(`no group for ${release} within 5s`)
}

describe("occurrence rollup", () => {
    it("counts repeats into one day bucket rather than one row each", async () => {
        const release = `test-shape-${crypto.randomUUID()}`

        await occurrence(release)
        const listed = await groupFor(release)
        await occurrence(release)
        await occurrence(release)

        const detail = await until(listed.fingerprint, group => group.occurrences >= 3)

        // One bucket, three occurrences. A key that failed to conflict would
        // give three buckets of one — a chart with a bar per occurrence, which
        // is data that answers nothing.
        expect(detail.days.length).toBe(1)
        expect(detail.days[0]!.count).toBe(3)
        expect(detail.days[0]!.release).toBe(release)
        expect(detail.occurrences).toBe(3)
    })

    it("keys buckets by release, so 'did my fix work' is answerable", async () => {
        const before = `test-shape-a-${crypto.randomUUID()}`
        const after = `test-shape-b-${crypto.randomUUID()}`
        await occurrence(before)
        await occurrence(after)

        const listed = await groupFor(after)
        const detail = await staff().group(listed.fingerprint)

        // Different releases fingerprint as different GROUPS (release is in the
        // fingerprint), so this group carries only its own release. That is the
        // property the per-release chart depends on being true.
        expect(detail.days.every(bucket => bucket.release === after)).toBe(true)
    })
})

describe("fixed, reopened, and the memory between", () => {
    it("keeps lastResolvedAt across a recurrence, so a regression is legible", async () => {
        const release = `test-shape-${crypto.randomUUID()}`
        await occurrence(release)
        const listed = await groupFor(release)

        await staff().resolve(listed.fingerprint, true)
        const fixed = await staff().group(listed.fingerprint)
        expect(fixed.resolvedAt).not.toBeNull()
        expect(fixed.lastResolvedAt).not.toBeNull()

        // The recurrence must clear the STATE — the group belongs back on the
        // list — while keeping the MEMORY, or "back after I fixed it" is
        // indistinguishable from "nobody has triaged this".
        await occurrence(release)

        const regressed = await until(listed.fingerprint, group => group.resolvedAt === null)
        expect(regressed.resolvedAt).toBeNull()
        expect(regressed.lastResolvedAt).not.toBeNull()
    })

    it("404s an unknown fingerprint rather than inventing an empty group", async () => {
        // The URL is bookmarkable, so a stale link is an ordinary outcome. A
        // page rendering "0 occurrences" for a group that never existed is a
        // worse answer than saying it is not there.
        await expect(staff().group("definitely-not-a-real-fingerprint")).rejects.toThrow()
    })
})
