import { describe, expect, test } from "bun:test"
import { SHEPARD_DECAY, distance, explain, from, generalisation, similarity } from "../../../src/pure"
import { testSpace } from "../../space"

describe("distance", () => {
    test("a position is zero distance from itself", () => {
        const space = testSpace()
        const position = from(space, { threat: 0.8, fragile: 0.2, noisy: 1, large: 0.5, interactive: 0 })
        expect(distance(space, position, position)).toBeCloseTo(0, 6)
    })

    test("similarity is one minus distance", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.8, noisy: 1 })
        const b = from(space, { threat: 0.2, noisy: 1 })
        expect(similarity(space, a, b)).toBeCloseTo(1 - distance(space, a, b), 6)
    })

    test("euclidean keeps magnitude — wary and terrified are not the same", () => {
        const space = testSpace()
        const wary = from(space, { threat: 0.2, fragile: 0.1 })
        const terrified = from(space, { threat: 1, fragile: 0.5 })
        expect(distance(space, wary, terrified, { domain: "risk" })).toBeGreaterThan(0.3)
    })

    test("cosine discards magnitude — same ratios compare as identical", () => {
        const space = testSpace()
        const small = from(space, { noisy: 0.2, large: 0.4 })
        const big = from(space, { noisy: 0.5, large: 1 })
        expect(distance(space, small, big, { domain: "form" })).toBeCloseTo(0, 5)
    })

    test("only axes measured on BOTH sides are compared", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.5, noisy: 1 })
        const b = from(space, { threat: 0.5, large: 0.1 })

        const detail = explain(space, a, b)
        expect(detail.compared).toBe(1)
        expect(detail.distance).toBeCloseTo(0, 6)
        expect(detail.domains.find(d => d.domain === "form")?.compared).toBe(0)
    })

    test("APPENDING an axis does not shift existing distances", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.8 })
        const b = from(space, { threat: 0.2 })
        const before = distance(space, a, b)

        // A later record measures an axis the earlier two never did.
        const widened = from(space, { threat: 0.2, interactive: 1 })
        expect(distance(space, a, widened)).toBeCloseTo(before, 6)
    })

    test("no measured overlap throws — that is not zero similarity", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.5 })
        const b = from(space, { noisy: 1 })
        expect(() => distance(space, a, b)).toThrow(/Share No Measured Axis|measured/)
    })

    test("explain reports incomparability instead of throwing, with NaN as the poison value", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.5 })
        const b = from(space, { noisy: 1 })

        const detail = explain(space, a, b)
        expect(detail.compared).toBe(0)
        expect(Number.isNaN(detail.distance)).toBe(true)
    })

    test("domain weight changes the combination", () => {
        const space = testSpace()
        // risk is weight 2, use is weight 1 — a risk difference should pull harder
        const a = from(space, { threat: 0, fragile: 0, interactive: 0 })
        const riskMoved = from(space, { threat: 1, fragile: 1, interactive: 0 })
        const useMoved = from(space, { threat: 0, fragile: 0, interactive: 1 })
        expect(distance(space, a, riskMoved)).toBeGreaterThan(distance(space, a, useMoved))
    })

    test("scoping to one domain ignores the others entirely", () => {
        const space = testSpace()
        const a = from(space, { threat: 0, interactive: 0 })
        const b = from(space, { threat: 0, interactive: 1 })
        expect(distance(space, a, b, { domain: "risk" })).toBeCloseTo(0, 6)
    })

    test("a domain with no overlap throws when scoped to it", () => {
        const space = testSpace()
        const a = from(space, { threat: 0.5 })
        const b = from(space, { threat: 0.5 })
        expect(() => distance(space, a, b, { domain: "form" })).toThrow(/Share No Measured Axis|form/)
    })
})

describe("generalisation (Shepard)", () => {
    test("decays exponentially rather than linearly", () => {
        const space = testSpace()
        const a = from(space, { threat: 0, fragile: 0 })
        const b = from(space, { threat: 0.5, fragile: 0.5 })

        const linear = similarity(space, a, b, { domain: "risk" })
        const shepard = generalisation(space, a, b, { domain: "risk" })
        expect(shepard).toBeLessThan(linear)
        expect(shepard).toBeCloseTo(Math.exp(-SHEPARD_DECAY * 0.5), 5)
    })

    test("identical positions generalise fully", () => {
        const space = testSpace()
        const position = from(space, { threat: 0.4, fragile: 0.6 })
        expect(generalisation(space, position, position, { domain: "risk" })).toBeCloseTo(1, 6)
    })

    test("RANKING is invariant — which is why it is a separate function, not a replacement", () => {
        const space = testSpace()
        const target = from(space, { threat: 1, fragile: 1 })
        const candidates = [
            from(space, { threat: 0.9, fragile: 0.9 }),
            from(space, { threat: 0.2, fragile: 0.2 }),
            from(space, { threat: 0.6, fragile: 0.6 }),
        ]

        const byLinear = [...candidates].sort(
            (x, y) => similarity(space, target, y, { domain: "risk" }) - similarity(space, target, x, { domain: "risk" })
        )
        const byShepard = [...candidates].sort(
            (x, y) =>
                generalisation(space, target, y, { domain: "risk" }) -
                generalisation(space, target, x, { domain: "risk" })
        )
        expect(byShepard).toEqual(byLinear)
    })

    test("decay is tunable — a larger c makes the tail fall away faster", () => {
        const space = testSpace()
        const a = from(space, { threat: 0, fragile: 0 })
        const b = from(space, { threat: 0.5, fragile: 0.5 })
        expect(generalisation(space, a, b, { domain: "risk", decay: 8 })).toBeLessThan(
            generalisation(space, a, b, { domain: "risk", decay: 1 })
        )
    })
})
