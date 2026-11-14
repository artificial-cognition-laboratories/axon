import { describe, expect, test } from "bun:test"
import { DEFAULT_RADIUS, SHEPARD_DECAY, claimants, fit, from, has, membership, nearestPrototype, region } from "../../../src/pure"
import { testSpace } from "../../space"

describe("region", () => {
    test("a region with no prototypes throws — it would claim nothing and everything", () => {
        expect(() => region({ name: "empty", prototypes: [] })).toThrow(/At Least One Coordinate|prototypes/)
    })

    test("fit builds one prototype over its members", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 0.8 }), from(space, { threat: 1 })])
        expect(r.prototypes).toHaveLength(1)
        expect(r.count).toBe(2)
    })

    test("fit with a spread splits disjoint clusters into separate prototypes", () => {
        const space = testSpace()
        // wood-like and stone-like: one centroid would land between them, in
        // empty space, matching neither.
        const r = fit(
            space,
            "block",
            [
                from(space, { fragile: 1, threat: 0 }),
                from(space, { fragile: 0.9, threat: 0 }),
                from(space, { fragile: 0, threat: 0.9 }),
                from(space, { fragile: 0, threat: 1 }),
            ],
            { spread: 0.3, domain: "risk" }
        )
        expect(r.prototypes).toHaveLength(2)
        expect(r.count).toBe(4)
    })
})

describe("membership", () => {
    test("is graded, so the caller owns the threshold and can hold hysteresis", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 1, fragile: 1 })], { domain: "risk" })

        expect(membership(space, r, from(space, { threat: 1, fragile: 1 }))).toBeCloseTo(1, 5)
        expect(membership(space, r, from(space, { threat: 0.5, fragile: 0.5 }))).toBeLessThan(0.3)
    })

    test("has an exponential FLOOR rather than reaching zero — a threshold must sit above it", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 1, fragile: 1 })], { domain: "risk" })

        // Shepard decay means maximum distance generalises to e^-c, not to 0. A
        // caller treating "0 means nothing in common" would never see it.
        const furthest = membership(space, r, from(space, { threat: 0, fragile: 0 }))
        expect(furthest).toBeCloseTo(Math.exp(-SHEPARD_DECAY), 5)
        expect(furthest).toBeGreaterThan(0)
    })

    test("takes the best over prototypes, so a multi-modal concept works", () => {
        const space = testSpace()
        const r = region({
            name: "block",
            prototypes: [from(space, { fragile: 1, threat: 0 }), from(space, { fragile: 0, threat: 1 })],
            domain: "risk",
        })
        expect(membership(space, r, from(space, { fragile: 0, threat: 1 }))).toBeCloseTo(1, 5)
    })
})

describe("has", () => {
    test("claims a position inside the radius and refuses one outside", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 1, fragile: 1 })], { radius: 0.2, domain: "risk" })

        expect(has(space, r, from(space, { threat: 0.95, fragile: 0.95 }))).toBe(true)
        expect(has(space, r, from(space, { threat: 0.1, fragile: 0.1 }))).toBe(false)
    })
})

describe("claimants", () => {
    test("returns claiming regions nearest first", () => {
        const space = testSpace()
        const near = fit(space, "near", [from(space, { threat: 0.9, fragile: 0.9 })], { radius: 0.5, domain: "risk" })
        const far = fit(space, "far", [from(space, { threat: 0.6, fragile: 0.6 })], { radius: 0.5, domain: "risk" })

        const hits = claimants(space, [far, near], from(space, { threat: 1, fragile: 1 }))
        expect(hits.map(hit => hit.region.name)).toEqual(["near", "far"])
    })

    test("EMPTY is the novelty signal — recognition and novelty are one call", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 1, fragile: 1 })], { radius: 0.1, domain: "risk" })
        expect(claimants(space, [r], from(space, { threat: 0, fragile: 0 }))).toEqual([])
    })

    test("a region judged in one domain ignores positions that differ only elsewhere", () => {
        const space = testSpace()
        const r = fit(space, "hazard", [from(space, { threat: 1, fragile: 1, interactive: 0 })], {
            radius: 0.1,
            domain: "risk",
        })
        const sameRiskDifferentUse = from(space, { threat: 1, fragile: 1, interactive: 1 })
        expect(nearestPrototype(space, r, sameRiskDifferentUse)).toBeCloseTo(0, 5)
    })
})

describe("fitted radius", () => {
    test("a radius is DERIVED from member spread rather than defaulted", () => {
        const space = testSpace()
        const tight = fit(
            space,
            "tight",
            [from(space, { threat: 0.5, fragile: 0.5 }), from(space, { threat: 0.52, fragile: 0.48 })],
            { domain: "risk" }
        )
        const loose = fit(
            space,
            "loose",
            [from(space, { threat: 0.1, fragile: 0.1 }), from(space, { threat: 0.9, fragile: 0.9 })],
            { domain: "risk" }
        )

        expect(tight.radius).toBeLessThan(loose.radius)
        expect(tight.radius).not.toBe(DEFAULT_RADIUS)
    })

    test("a fitted radius claims its own members", () => {
        const space = testSpace()
        const members = [
            from(space, { threat: 0.5, fragile: 0.5 }),
            from(space, { threat: 0.6, fragile: 0.45 }),
            from(space, { threat: 0.4, fragile: 0.55 }),
        ]
        const r = fit(space, "mid", members, { domain: "risk" })
        for (const member of members) expect(has(space, r, member)).toBe(true)
    })

    test("an explicit radius still overrides the fit", () => {
        const space = testSpace()
        const r = fit(space, "fixed", [from(space, { threat: 0.5, fragile: 0.5 })], { radius: 0.4, domain: "risk" })
        expect(r.radius).toBe(0.4)
    })

    test("a single seed falls back to the constant — nothing to measure", () => {
        const space = testSpace()
        const r = region({ name: "seed", prototypes: [from(space, { threat: 0.5 })] })
        expect(r.radius).toBe(DEFAULT_RADIUS)
    })
})
