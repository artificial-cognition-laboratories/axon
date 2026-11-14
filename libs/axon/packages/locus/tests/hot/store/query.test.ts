import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

async function seeded() {
    const locus = await testLocus()
    const space = locus.space
    await locus.records.put({ id: "loud-block", coord: from(space, { noisy: 1, interactive: 0.2, threat: 0 }), at: 100 })
    await locus.records.put({ id: "quiet-tool", coord: from(space, { noisy: 0, interactive: 0.9, threat: 0 }), at: 200 })
    await locus.records.put({ id: "loud-beast", coord: from(space, { noisy: 0.9, interactive: 0.8, threat: 0.9 }), at: 300 })
    await locus.records.put({ id: "unassessed", coord: from(space, { large: 0.5 }), at: 400 })
    return locus
}

describe("query", () => {
    test("a box query narrows on one axis", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ where: { noisy: { gt: 0.5 } } })
        expect(result.hits.map(hit => hit.record.id).sort()).toEqual(["loud-beast", "loud-block"])
    })

    test("clauses compose — noisy AND interactive AND not dangerous", async () => {
        const locus = await seeded()
        const result = await locus.records.query({
            where: { noisy: { gt: 0.5 }, interactive: { lt: 0.5 }, threat: { lt: 0.5 } },
        })
        expect(result.hits.map(hit => hit.record.id)).toEqual(["loud-block"])
    })

    test("an unmeasured axis fails every value predicate, in both directions", async () => {
        const locus = await seeded()
        const above = await locus.records.query({ where: { noisy: { gt: 0.5 } } })
        const below = await locus.records.query({ where: { noisy: { lt: 0.5 } } })

        expect(above.hits.map(hit => hit.record.id)).not.toContain("unassessed")
        expect(below.hits.map(hit => hit.record.id)).not.toContain("unassessed")
    })

    test("{ measured } asks the question a value predicate cannot", async () => {
        const locus = await seeded()
        const unmeasured = await locus.records.query({ where: { noisy: { measured: false } } })
        expect(unmeasured.hits.map(hit => hit.record.id)).toEqual(["unassessed"])
    })

    test("between is inclusive on both ends", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ where: { interactive: { between: [0.2, 0.8] } } })
        expect(result.hits.map(hit => hit.record.id).sort()).toEqual(["loud-beast", "loud-block"])
    })

    test("a time window filters without touching the coordinate", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ when: { from: 150, to: 350 } })
        expect(result.hits.map(hit => hit.record.id).sort()).toEqual(["loud-beast", "quiet-tool"])
    })

    test("limit truncates", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ limit: 2 })
        expect(result.hits).toHaveLength(2)
    })
})

describe("plan", () => {
    test("every query reports its clauses and their selectivity", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ when: { from: 150 }, where: { noisy: { gt: 0.5 } } })

        expect(result.plan.clauses.map(clause => clause.kind)).toEqual(["live", "time", "axis"])
        expect(result.plan.clauses[0]!.after).toBe(4)
        expect(result.plan.clauses[1]!.after).toBe(3)
        expect(result.plan.clauses[2]!.after).toBe(1)
    })

    test("the plan says which clause ate the rows", async () => {
        const locus = await seeded()
        const result = await locus.records.query({ where: { noisy: { gt: 0.99 }, threat: { gt: 0.99 } } })

        expect(result.hits).toHaveLength(0)
        const killer = result.plan.clauses.find(clause => clause.after === 0)
        expect(killer?.detail).toContain("threat")
    })

    test("a box query does not rank", async () => {
        const locus = await seeded()
        const result = await locus.records.query({})
        expect(result.plan.ranked).toBe(0)
        expect(result.plan.metric).toBeUndefined()
        expect(result.hits.every(hit => hit.distance === undefined)).toBe(true)
    })
})
