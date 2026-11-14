import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

/** Three tight groups in the risk domain, plus one outlier that belongs to none. */
async function seeded() {
    const locus = await testLocus()
    const space = locus.space
    // Centres kept clear of 1 so every member stays inside the cube — readings
    // outside [0,1] are refused at the door, which this fixture originally proved.
    const groups = [0, 0.4, 0.9]

    for (const centre of groups) {
        for (let i = 0; i < 4; i++) {
            await locus.records.put({
                coord: from(space, { threat: centre + i * 0.01, fragile: centre }),
                at: 1000 + i,
            })
        }
    }
    await locus.records.put({ id: "outlier", coord: from(space, { threat: 0.25, fragile: 0.75 }), at: 9000 })
    return locus
}

describe("planConsolidation", () => {
    test("proposes clusters without touching anything", async () => {
        const locus = await seeded()
        const before = locus.records.count

        const report = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })

        expect(report.clusters).toHaveLength(3)
        expect(locus.records.count).toBe(before)
    })

    test("reports before and after, which is the compression ratio", async () => {
        const locus = await seeded()
        const report = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })

        expect(report.before).toBe(13)
        // 12 members become 3 prototypes; the outlier is untouched.
        expect(report.after).toBe(4)
    })

    test("a lone position is never a cluster of one", async () => {
        const locus = await seeded()
        const report = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })
        expect(report.clusters.every(cluster => cluster.members.length > 1)).toBe(true)
    })

    test("a cluster records the span it now stands for", async () => {
        const locus = await seeded()
        const report = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })
        const cluster = report.clusters[0]!
        expect(cluster.from).toBe(1000)
        expect(cluster.to).toBe(1003)
    })

    test("a larger radius compresses harder — consolidation is monotone with one knob", async () => {
        const locus = await seeded()
        const tight = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })
        const loose = locus.records.planConsolidation({ radius: 0.9, domain: "risk" })
        expect(loose.after).toBeLessThan(tight.after)
    })
})

describe("consolidate", () => {
    test("members are replaced by their prototype", async () => {
        const locus = await seeded()
        const report = await locus.records.consolidate({ radius: 0.05, domain: "risk" })

        expect(locus.records.count).toBe(report.after)
        for (const id of report.clusters[0]!.members) {
            await expect(locus.records.get(id)).rejects.toThrow(/no record with id/)
        }
    })

    test("POSITION survives while precision is lost — the region remains findable", async () => {
        const locus = await seeded()
        const probe = from(locus.space, { threat: 0.9, fragile: 0.9 })
        const before = await locus.records.near(probe, { domain: "risk", limit: 1 })

        await locus.records.consolidate({ radius: 0.05, domain: "risk" })
        const after = await locus.records.near(probe, { domain: "risk", limit: 1 })

        // The episode is gone, but "something like this, in this region" is not.
        expect(after.hits).toHaveLength(1)
        expect(Math.abs(after.hits[0]!.distance! - before.hits[0]!.distance!)).toBeLessThan(0.05)
    })

    test("the prototype records what it absorbed", async () => {
        const locus = await seeded()
        const report = await locus.records.consolidate({ radius: 0.05, domain: "risk" })

        const survivors = await locus.records.query({})
        const prototypes = survivors.hits.filter(hit => hit.record.payload !== undefined)
        expect(prototypes).toHaveLength(report.clusters.length)

        const payload = prototypes[0]!.record.payload as { consolidated: string[] }
        expect(payload.consolidated).toHaveLength(4)
    })

    test("an untouched outlier is still there afterwards", async () => {
        const locus = await seeded()
        await locus.records.consolidate({ radius: 0.05, domain: "risk" })
        expect((await locus.records.get("outlier")).coord.values[0]).toBeCloseTo(0.25, 2)
    })
})

describe("consolidation cost", () => {
    test("comparisons scale with LEADERS, not with records squared", async () => {
        const locus = await testLocus()
        const space = locus.space

        // 600 records in 3 tight groups. Pairwise would be ~180k comparisons;
        // leader clustering should be near 600 x 3.
        const inputs = []
        for (let i = 0; i < 600; i++) {
            const centre = [0.1, 0.5, 0.9][i % 3]!
            inputs.push({ coord: from(space, { threat: centre, fragile: centre }) })
        }
        await locus.records.putMany(inputs)

        const report = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })

        expect(report.leaders).toBe(3)
        expect(report.comparisons).toBeLessThan(600 * 5)
        expect(report.clusters).toHaveLength(3)
    })

    test("maxLeaders stops a pass that is not clustering, and SAYS it did", async () => {
        const locus = await testLocus()
        const space = locus.space

        // Deliberately unclusterable: every record far from every other at this radius.
        const inputs = []
        for (let i = 0; i < 200; i++) {
            inputs.push({ coord: from(space, { threat: i / 200, fragile: (i * 7 % 200) / 200 }) })
        }
        await locus.records.putMany(inputs)

        const guarded = locus.records.planConsolidation({ radius: 0.001, domain: "risk", maxLeaders: 20 })
        expect(guarded.truncated).toBe(true)
        expect(guarded.leaders).toBe(20)

        const full = locus.records.planConsolidation({ radius: 0.001, domain: "risk" })
        expect(full.truncated).toBe(false)
        // The degenerate case is exactly where cost explodes, which is what the guard is for.
        expect(full.comparisons).toBeGreaterThan(guarded.comparisons)
    })

    test("scoping to a slice of rows bounds the cost — never consolidate the whole store", async () => {
        const locus = await testLocus()
        const space = locus.space
        const inputs = []
        for (let i = 0; i < 400; i++) inputs.push({ coord: from(space, { threat: (i % 4) / 4, fragile: 0.5 }), at: i })
        await locus.records.putMany(inputs)

        // "Everything added recently" — the shape a sleep task would use.
        const recent = await locus.records.query({ when: { from: 350 } })
        const slots = recent.hits.map(hit => locus.records.slotOf(hit.record.id)!).filter(slot => slot !== null)

        const scoped = locus.records.planConsolidation({ radius: 0.05, domain: "risk", slots: slots })
        const everything = locus.records.planConsolidation({ radius: 0.05, domain: "risk" })

        expect(scoped.before).toBe(50)
        expect(everything.before).toBe(400)
        expect(scoped.comparisons).toBeLessThan(everything.comparisons)
    })

    test("running again with the same radius is a no-op — consolidation is monotone", async () => {
        const locus = await testLocus()
        const space = locus.space
        const inputs = []
        for (let i = 0; i < 90; i++) {
            const centre = [0.1, 0.5, 0.9][i % 3]!
            inputs.push({ coord: from(space, { threat: centre, fragile: centre }) })
        }
        await locus.records.putMany(inputs)

        await locus.records.consolidate({ radius: 0.05, domain: "risk" })
        const settled = locus.records.count
        const again = await locus.records.consolidate({ radius: 0.05, domain: "risk" })

        expect(again.clusters).toHaveLength(0)
        expect(locus.records.count).toBe(settled)
    })
})
