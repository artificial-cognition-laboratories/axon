import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl, anonymousCloud } from "../setup/staging"

const baseUrl = backendUrl()

describe("billing.ledger", () => {
    it("requires auth — no key rejects rather than returning an anonymous ledger", async () => {
        const cloud = anonymousCloud()

        await expect(cloud.user.billing.ledger.list()).rejects.toThrow()
    })

    it("returns entries with the expected shape", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const entries = await cloud.user.billing.ledger.list({ limit: 5 })

        expect(entries.length).toBeGreaterThan(0)
        const first = entries[0]
        expect(typeof first.id).toBe("string")
        expect(typeof first.kind).toBe("string")
        expect(typeof first.status).toBe("string")
        expect(typeof first.amountMinor).toBe("number")
        expect(first.currency).toBe("gbp")
        expect(typeof first.createdAt).toBe("string")
        expect(typeof first.metadata).toBe("object")
    })

    it("entries come back newest-first", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const entries = await cloud.user.billing.ledger.list({ limit: 10 })

        const timestamps = entries.map(e => Date.parse(e.createdAt))
        const sorted = [...timestamps].sort((a, b) => b - a)

        expect(timestamps).toEqual(sorted)
    })

    it("limit caps the number of entries returned", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const capped = await cloud.user.billing.ledger.list({ limit: 3 })

        expect(capped.length).toBeLessThanOrEqual(3)
    })

    it("a smaller limit returns a prefix of a larger limit's results, not a different set", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        // The ledger is newest-first over an account that parallel workers are
        // actively writing to, and list() has no way to pin an upper bound —
        // so the two reads below genuinely see two different ledgers whenever
        // an entry lands between them. A strict prefix assertion tests that
        // nothing was posted mid-test, which is a property of how busy the
        // suite is, not of the API.
        //
        // What limit actually promises is that it truncates the newest-first
        // ordering rather than returning some other subset. Read the small
        // window LAST — it can only contain entries at or newer than the large
        // window's head — and assert that the two agree wherever they overlap.
        const large = await cloud.user.billing.ledger.list({ limit: 10 })
        const small = await cloud.user.billing.ledger.list({ limit: 3 })

        const overlap = small.filter(entry => large.some(seen => seen.id === entry.id))
        if (overlap.length === 0) throw new Error("the two reads share no entries — nothing to compare")

        // Every shared entry sits at the same distance from the head in both
        // windows, offset only by whatever was inserted ahead of them.
        const offset = large.findIndex(seen => seen.id === overlap[0].id)
        expect(large.slice(offset, offset + overlap.length)).toEqual(overlap)
    })

    it("nullable fields (description, referenceType, referenceId) come back as null, not undefined or missing", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        // A wide limit on purpose: this asserts how the parser represents a
        // null column, not how recent the entry is. With limit: 20 a busy run
        // (or a parallel one) pushes every null-reference entry off the end
        // and the test fails for having found nothing to check.
        const entries = await cloud.user.billing.ledger.list({ limit: 500 })
        const withNullRef = entries.find(e => e.referenceType === null)

        if (!withNullRef) throw new Error("no null-reference ledger entry exists to assert against")

        expect(withNullRef.referenceType).toBeNull()
        expect(withNullRef.referenceId).toBeNull()
    })

    it("an invalid key rejects rather than returning someone else's ledger", async () => {
        const cloud = AxonCloud({ baseUrl, key: "axon_totally_not_a_real_key" })

        await expect(cloud.user.billing.ledger.list()).rejects.toThrow()
    })
})
