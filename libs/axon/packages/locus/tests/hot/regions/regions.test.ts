import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

describe("regions", () => {
    test("fitOf stores a named concept", async () => {
        const locus = await testLocus()
        const r = await locus.regions.fitOf("hazard", [from(locus.space, { threat: 1, fragile: 1 })], { domain: "risk" })

        expect(r.name).toBe("hazard")
        expect(locus.regions.exists("hazard")).toBe(true)
        expect(locus.regions.get("hazard").count).toBe(1)
    })

    test("fitFrom builds a concept out of whatever a query returns", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ coord: from(space, { threat: 0.9, fragile: 0.8 }) })
        await locus.records.put({ coord: from(space, { threat: 0.95, fragile: 0.9 }) })
        await locus.records.put({ coord: from(space, { threat: 0, fragile: 0 }) })

        const r = await locus.regions.fitFrom("hazard", { where: { threat: { gt: 0.5 } } }, { domain: "risk" })
        expect(r.count).toBe(2)
    })

    test("claims is recognition, and an empty result is novelty — one call", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.regions.fitOf("hazard", [from(space, { threat: 1, fragile: 1 })], { radius: 0.2, domain: "risk" })

        const known = locus.regions.claims(from(space, { threat: 0.95, fragile: 0.95 }))
        expect(known.map(hit => hit.region.name)).toEqual(["hazard"])

        const novel = locus.regions.claims(from(space, { threat: 0, fragile: 0 }))
        expect(novel).toEqual([])
    })

    test("open turns a novel position into a concept — formation, not configuration", async () => {
        const locus = await testLocus()
        const space = locus.space
        const novel = from(space, { threat: 0, fragile: 0 })

        expect(locus.regions.claims(novel)).toEqual([])
        await locus.regions.open("harmless", novel, { radius: 0.2, domain: "risk" })
        expect(locus.regions.claims(novel).map(hit => hit.region.name)).toEqual(["harmless"])
    })

    test("a region of one is honestly marked as a guess by its count", async () => {
        const locus = await testLocus()
        const r = await locus.regions.open("hunch", from(locus.space, { threat: 0.5 }))
        expect(r.count).toBe(1)
    })

    test("absorb widens a region rather than replacing it", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.regions.fitOf("hazard", [from(space, { threat: 1, fragile: 1 })], { radius: 0.1, domain: "risk" })

        const widened = await locus.regions.absorb("hazard", from(space, { threat: 0, fragile: 0 }))
        expect(widened.prototypes).toHaveLength(2)
        expect(widened.count).toBe(2)
        expect(locus.regions.has("hazard", from(space, { threat: 0, fragile: 0 }))).toBe(true)
    })

    test("membership is graded so the caller can hold hysteresis", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.regions.fitOf("hazard", [from(space, { threat: 1, fragile: 1 })], { domain: "risk" })

        const strong = locus.regions.membership("hazard", from(space, { threat: 1, fragile: 1 }))
        const weak = locus.regions.membership("hazard", from(space, { threat: 0.5, fragile: 0.5 }))
        expect(strong).toBeGreaterThan(weak)
        expect(weak).toBeGreaterThan(0)
    })

    test("an unknown region throws rather than reporting no membership", async () => {
        const locus = await testLocus()
        expect(() => locus.regions.get("ghost")).toThrow(/Region Not Found|ghost/)
    })

    test("delete reports whether it did anything", async () => {
        const locus = await testLocus()
        await locus.regions.open("temp", from(locus.space, { threat: 0.5 }))
        expect(await locus.regions.delete("temp")).toBe(true)
        expect(await locus.regions.delete("temp")).toBe(false)
    })
})
