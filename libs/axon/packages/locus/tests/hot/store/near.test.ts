import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

async function seeded() {
    const locus = await testLocus()
    const space = locus.space
    await locus.records.put({ id: "hazard", coord: from(space, { threat: 0.9, fragile: 0.1, interactive: 0 }) })
    await locus.records.put({ id: "mild", coord: from(space, { threat: 0.4, fragile: 0.1, interactive: 0 }) })
    await locus.records.put({ id: "calm", coord: from(space, { threat: 0, fragile: 0.1, interactive: 0 }) })
    await locus.records.put({ id: "elsewhere", coord: from(space, { noisy: 1, large: 1 }) })
    return locus
}

describe("near", () => {
    test("ranks by distance, nearest first", async () => {
        const locus = await seeded()
        const result = await locus.records.near(from(locus.space, { threat: 1, fragile: 0.1, interactive: 0 }))

        expect(result.hits.map(hit => hit.record.id)).toEqual(["hazard", "mild", "calm"])
        expect(result.hits[0]!.distance!).toBeLessThan(result.hits[1]!.distance!)
    })

    test("a row sharing no measured axis is DROPPED, not ranked last", async () => {
        const locus = await seeded()
        const result = await locus.records.near(from(locus.space, { threat: 1, fragile: 0.1, interactive: 0 }))
        expect(result.hits.map(hit => hit.record.id)).not.toContain("elsewhere")
    })

    test("filters narrow before the metric ranks", async () => {
        const locus = await seeded()
        const result = await locus.records.near(from(locus.space, { threat: 1, fragile: 0.1, interactive: 0 }), {
            where: { threat: { lt: 0.5 } },
        })

        expect(result.hits.map(hit => hit.record.id)).toEqual(["mild", "calm"])
        expect(result.plan.clauses.some(clause => clause.detail.includes("threat"))).toBe(true)
    })

    test("the plan names the metric and how many rows it scored", async () => {
        const locus = await seeded()
        const result = await locus.records.near(from(locus.space, { threat: 1, fragile: 0.1 }), { domain: "risk" })

        expect(result.plan.metric).toBe("distance")
        expect(result.plan.domain).toBe("risk")
        expect(result.plan.ranked).toBe(3)
    })

    test("scoping to a domain changes the ranking", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ id: "risky-quiet", coord: from(space, { threat: 1, fragile: 1, noisy: 0, large: 0.1 }) })
        await locus.records.put({ id: "safe-loud", coord: from(space, { threat: 0, fragile: 0, noisy: 1, large: 1 }) })

        const target = from(space, { threat: 1, fragile: 1, noisy: 1, large: 1 })
        const byRisk = await locus.records.near(target, { domain: "risk" })
        const byForm = await locus.records.near(target, { domain: "form" })

        expect(byRisk.hits[0]!.record.id).toBe("risky-quiet")
        expect(byForm.hits[0]!.record.id).toBe("safe-loud")
    })

    test("limit truncates after ranking, not before", async () => {
        const locus = await seeded()
        const result = await locus.records.near(from(locus.space, { threat: 1, fragile: 0.1, interactive: 0 }), { limit: 1 })

        expect(result.hits.map(hit => hit.record.id)).toEqual(["hazard"])
        expect(result.plan.ranked).toBe(3)
    })
})
