import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

describe("axis stats", () => {
    test("fill reports how many live rows measured each axis", async () => {
        const locus = await testLocus()
        await locus.records.put({ coord: from(locus.space, { threat: 0.5, noisy: 1 }) })
        await locus.records.put({ coord: from(locus.space, { threat: 0.7 }) })

        const stats = locus.stats.axes()
        expect(stats.find(axis => axis.name === "threat")?.fill).toBeCloseTo(1, 5)
        expect(stats.find(axis => axis.name === "noisy")?.fill).toBeCloseTo(0.5, 5)
        expect(stats.find(axis => axis.name === "large")?.fill).toBe(0)
    })

    test("a DEAD axis is visible as zero fill or zero variance", async () => {
        const locus = await testLocus()
        for (let i = 0; i < 10; i++) {
            await locus.records.put({ coord: from(locus.space, { threat: i / 10, interactive: 1 }) })
        }

        const stats = locus.stats.axes()
        // fires on everything, identically — contributes nothing but noise
        expect(stats.find(axis => axis.name === "interactive")?.variance).toBeCloseTo(0, 6)
        // nothing produces it at all
        expect(stats.find(axis => axis.name === "large")?.fill).toBe(0)
        // and a healthy axis looks different from both
        expect(stats.find(axis => axis.name === "threat")?.variance).toBeGreaterThan(0.05)
    })

    test("mean, min and max come from the measured rows only", async () => {
        const locus = await testLocus()
        await locus.records.put({ coord: from(locus.space, { threat: 0.2 }) })
        await locus.records.put({ coord: from(locus.space, { threat: 0.8 }) })
        await locus.records.put({ coord: from(locus.space, { noisy: 1 }) })

        const threat = locus.stats.axes().find(axis => axis.name === "threat")!
        expect(threat.mean).toBeCloseTo(0.5, 5)
        expect(threat.min).toBeCloseTo(0.2, 5)
        expect(threat.max).toBeCloseTo(0.8, 5)
    })

    test("deleted rows stop counting", async () => {
        const locus = await testLocus()
        const id = await locus.records.put({ coord: from(locus.space, { noisy: 1 }) })
        await locus.records.put({ coord: from(locus.space, { threat: 1 }) })
        await locus.records.delete(id)

        expect(locus.stats.axes().find(axis => axis.name === "noisy")?.fill).toBe(0)
    })
})

describe("correlations", () => {
    test("a DUPLICATE axis shows as r near 1 — one concept counted twice", async () => {
        const locus = await testLocus()
        for (let i = 0; i < 12; i++) {
            const value = i / 12
            await locus.records.put({ coord: from(locus.space, { threat: value, fragile: value, noisy: 1 - value }) })
        }

        const correlated = locus.stats.correlations({ minOverlap: 8, threshold: 0.9 })
        const pair = correlated.find(entry => entry.a === "threat" && entry.b === "fragile")
        expect(pair?.r).toBeCloseTo(1, 3)
    })

    test("an inverse relationship is reported too, strongest first", async () => {
        const locus = await testLocus()
        for (let i = 0; i < 12; i++) {
            const value = i / 12
            await locus.records.put({ coord: from(locus.space, { threat: value, noisy: 1 - value }) })
        }

        const correlated = locus.stats.correlations({ minOverlap: 8, threshold: 0.9 })
        expect(correlated[0]!.r).toBeCloseTo(-1, 3)
    })

    test("a thin overlap is suppressed — a perfect r over three rows is an artefact", async () => {
        const locus = await testLocus()
        for (let i = 0; i < 3; i++) {
            await locus.records.put({ coord: from(locus.space, { threat: i / 3, fragile: i / 3 }) })
        }
        expect(locus.stats.correlations({ minOverlap: 8 })).toEqual([])
    })
})
