import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

/**
 * Coverage is the design's normal state, not an edge case: producers own different
 * axes, and appending an axis deliberately leaves older records unmeasured on it.
 * Lab e4 measured `recall@1` collapsing 0.855 → 0.165 as coverage thinned while the
 * margin barely moved — a ranking full of plausible numbers, all of them wrong.
 *
 * So the package's job is to make that state VISIBLE and REFUSABLE. These are the
 * tests for both.
 */
describe("coverage in the plan", () => {
    test("every ranking reports the completeness of what it ranked", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ id: "full", coord: from(space, { threat: 0.5, fragile: 0.5, noisy: 0.5, large: 0.5 }) })
        await locus.records.put({ id: "thin", coord: from(space, { threat: 0.5 }) })

        const result = await locus.records.near(from(space, { threat: 0.5, fragile: 0.5, noisy: 0.5, large: 0.5 }))

        expect(result.plan.coverage).toBeDefined()
        expect(result.plan.coverage!.max).toBeCloseTo(1, 5)
        expect(result.plan.coverage!.min).toBeCloseTo(0.25, 5)
    })

    test("a wide min-to-max spread is the signature of an untrustworthy ranking", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ coord: from(space, { threat: 0.5, fragile: 0.5, noisy: 0.5, large: 0.5 }) })
        await locus.records.put({ coord: from(space, { threat: 0.5 }) })

        const wide = await locus.records.near(from(space, { threat: 0.5, fragile: 0.5, noisy: 0.5, large: 0.5 }))
        expect(wide.plan.coverage!.max - wide.plan.coverage!.min).toBeGreaterThan(0.5)
    })

    test("each hit carries the sample size its distance came from", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ id: "thin", coord: from(space, { threat: 0.5 }) })

        const result = await locus.records.near(from(space, { threat: 0.5, fragile: 0.5 }))
        expect(result.hits[0]!.compared).toBe(1)
    })
})

describe("minCompleteness", () => {
    test("refuses candidates too thin to compete", async () => {
        const locus = await testLocus()
        const space = locus.space
        const full = { threat: 0.9, fragile: 0.9, noisy: 0.9, large: 0.9 }
        await locus.records.put({ id: "full", coord: from(space, full) })
        await locus.records.put({ id: "thin", coord: from(space, { threat: 0.9 }) })

        const all = await locus.records.near(from(space, full))
        expect(all.hits.map(hit => hit.record.id).sort()).toEqual(["full", "thin"])

        const strict = await locus.records.near(from(space, full), { minCompleteness: 0.9 })
        expect(strict.hits.map(hit => hit.record.id)).toEqual(["full"])
    })

    test("a thin candidate can beat a complete one on luck — which is the point of the floor", async () => {
        const locus = await testLocus()
        const space = locus.space
        const probe = from(space, { threat: 1, fragile: 1, noisy: 1, large: 1 })

        // Genuinely the right answer: close on every axis.
        await locus.records.put({ id: "right", coord: from(space, { threat: 0.85, fragile: 0.85, noisy: 0.85, large: 0.85 }) })
        // Wrong, but measured only where it happens to match exactly.
        await locus.records.put({ id: "lucky", coord: from(space, { threat: 1 }) })

        const unfiltered = await locus.records.near(probe, { limit: 1 })
        expect(unfiltered.hits[0]!.record.id).toBe("lucky")

        const filtered = await locus.records.near(probe, { minCompleteness: 0.9, limit: 1 })
        expect(filtered.hits[0]!.record.id).toBe("right")
    })

    test("the floor reports as a clause, so a ranking says what dropped its candidates", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ coord: from(space, { threat: 0.5, fragile: 0.5 }) })
        await locus.records.put({ coord: from(space, { threat: 0.5 }) })

        const result = await locus.records.near(from(space, { threat: 0.5, fragile: 0.5 }), { minCompleteness: 1 })
        const clause = result.plan.clauses.find(c => c.kind === "coverage")

        expect(clause?.detail).toContain("completeness")
        expect(clause?.before).toBe(2)
        expect(clause?.after).toBe(1)
    })

    test("completeness is relative to the PROBE's measured axes, not to the whole space", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ id: "risk-only", coord: from(space, { threat: 0.5, fragile: 0.5 }) })

        // The probe measures two axes; the candidate measures both. Fully complete,
        // even though three axes in the space went unmeasured on both sides.
        const result = await locus.records.near(from(space, { threat: 0.5, fragile: 0.5 }), { minCompleteness: 1 })
        expect(result.hits.map(hit => hit.record.id)).toEqual(["risk-only"])
    })
})

describe("stats.coverage", () => {
    test("a complete-or-absent store reports no partial domains — the safe shape", async () => {
        const locus = await testLocus()
        const space = locus.space
        // risk fully measured, form fully absent
        await locus.records.put({ coord: from(space, { threat: 0.5, fragile: 0.5 }) })
        // form fully measured, risk fully absent
        await locus.records.put({ coord: from(space, { noisy: 0.5, large: 0.5 }) })

        const coverage = locus.stats.coverage()
        const risk = coverage.find(entry => entry.domain === "risk")!
        expect(risk.complete).toBeCloseTo(0.5, 5)
        expect(risk.absent).toBeCloseTo(0.5, 5)
        expect(risk.partial).toBe(0)
    })

    test("a half-measured domain shows up as partial — the dangerous middle", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ coord: from(space, { threat: 0.5 }) })
        await locus.records.put({ coord: from(space, { threat: 0.5, fragile: 0.5 }) })

        const risk = locus.stats.coverage().find(entry => entry.domain === "risk")!
        expect(risk.partial).toBeCloseTo(0.5, 5)
        expect(risk.mean).toBeCloseTo(0.75, 5)
    })
})
