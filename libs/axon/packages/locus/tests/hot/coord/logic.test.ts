import { describe, expect, test } from "bun:test"
import { complement, conjunction, disjunction, from, match, read, TNORMS } from "../../../src/pure"
import { testSpace } from "../../space"

describe("t-norms", () => {
    test("every operator satisfies the boundary condition T(a, 0) = 0", () => {
        for (const [name, tnorm] of Object.entries(TNORMS)) {
            expect(tnorm(0.8, 0)).toBe(0)
            expect(tnorm(0.8, 1)).toBeCloseTo(0.8, 6)
            expect(name).toBeTruthy()
        }
    })

    test("an average is NOT a valid AND — the reason commonality is not called intersect", () => {
        const average = (a: number, b: number) => (a + b) / 2
        expect(average(0.8, 0)).toBe(0.4)
        expect(TNORMS.min(0.8, 0)).toBe(0)
    })
})

describe("conjunction", () => {
    test("min takes the bottleneck", () => {
        const space = testSpace()
        const result = conjunction(space, from(space, { noisy: 0.8 }), from(space, { noisy: 0.6 }))
        expect(read(space, result, "noisy")?.value).toBeCloseTo(0.6, 6)
    })

    test("product punishes weakness in either side", () => {
        const space = testSpace()
        const result = conjunction(space, from(space, { noisy: 0.8 }), from(space, { noisy: 0.6 }), { tnorm: "product" })
        expect(read(space, result, "noisy")?.value).toBeCloseTo(0.48, 6)
    })

    test("an axis measured on only one side stays unmeasured", () => {
        const space = testSpace()
        const result = conjunction(space, from(space, { noisy: 0.8, threat: 0.5 }), from(space, { noisy: 0.6 }))
        expect(read(space, result, "threat")).toBeNull()
    })

    test("confidence is the weaker of the two inputs", () => {
        const space = testSpace()
        const result = conjunction(
            space,
            from(space, { noisy: { value: 0.8, confidence: 0.9 } }),
            from(space, { noisy: { value: 0.6, confidence: 0.3 } })
        )
        expect(read(space, result, "noisy")?.confidence).toBeCloseTo(0.3, 6)
    })
})

describe("disjunction", () => {
    test("max takes the stronger side", () => {
        const space = testSpace()
        const result = disjunction(space, from(space, { noisy: 0.2 }), from(space, { noisy: 0.7 }))
        expect(read(space, result, "noisy")?.value).toBeCloseTo(0.7, 6)
    })
})

describe("complement", () => {
    test("a measured value inverts", () => {
        const space = testSpace()
        const result = complement(space, from(space, { noisy: 0.25 }))
        expect(read(space, result, "noisy")?.value).toBeCloseTo(0.75, 6)
    })

    test("an unmeasured axis stays unmeasured — nobody asked is not certainly not", () => {
        const space = testSpace()
        const result = complement(space, from(space, { noisy: 0.25 }))
        expect(read(space, result, "threat")).toBeNull()
    })
})

describe("match", () => {
    test("a fully satisfied pattern is 1", () => {
        const space = testSpace()
        const pattern = from(space, { threat: 0.6, fragile: 0.5 })
        const position = from(space, { threat: 0.9, fragile: 0.8 })
        expect(match(space, pattern, position)).toBeCloseTo(1, 6)
    })

    test("a half-satisfied pattern reports half, not three quarters", () => {
        const space = testSpace()
        const pattern = from(space, { threat: 1, fragile: 1 })
        const position = from(space, { threat: 1, fragile: 0 })
        // The archive's averaging intersect reported 0.75 here and would have
        // fired an intervention on a pattern with an unmet condition.
        expect(match(space, pattern, position)).toBeCloseTo(0.5, 6)
    })

    test("an axis the pattern wants but the position never measured counts as unsatisfied", () => {
        const space = testSpace()
        const pattern = from(space, { threat: 1, fragile: 1 })
        const position = from(space, { threat: 1 })
        expect(match(space, pattern, position)).toBeCloseTo(0.5, 6)
    })

    test("a pattern that asks nothing is trivially satisfied", () => {
        const space = testSpace()
        expect(match(space, from(space, {}), from(space, { threat: 1 }))).toBe(1)
    })
})
