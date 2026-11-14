import { describe, expect, test } from "bun:test"
import { centroid, commonality, difference, from, interpolate, read, shift } from "../../../src/pure"
import { testSpace } from "../../space"

describe("commonality", () => {
    test("averages axes measured on both sides", () => {
        const space = testSpace()
        const result = commonality(space, from(space, { threat: 0.8 }), from(space, { threat: 0.4 }))
        expect(read(space, result, "threat")?.value).toBeCloseTo(0.6, 6)
    })

    test("ignores axes measured on only one side", () => {
        const space = testSpace()
        const result = commonality(space, from(space, { threat: 0.8, noisy: 1 }), from(space, { threat: 0.4 }))
        expect(read(space, result, "noisy")).toBeNull()
    })
})

describe("difference", () => {
    test("returns named signed gaps, biggest first", () => {
        const space = testSpace()
        const goal = from(space, { threat: 0, fragile: 1, interactive: 1 })
        const current = from(space, { threat: 0.3, fragile: 0.2, interactive: 0.9 })

        const gaps = difference(space, goal, current)
        expect(gaps.map(gap => gap.axis)).toEqual(["fragile", "threat", "interactive"])
        expect(gaps[0]!.gap).toBeCloseTo(0.8, 5)
        expect(gaps[1]!.gap).toBeCloseTo(-0.3, 5)
        expect(gaps[2]!.gap).toBeCloseTo(0.1, 5)
    })

    test("is a stop condition and a ranked todo list from one computation", () => {
        const space = testSpace()
        const goal = from(space, { fragile: 1, interactive: 1 })
        const current = from(space, { fragile: 1, interactive: 1 })
        expect(difference(space, goal, current)).toEqual([])
    })

    test("omits axes measured on only one side — an unasked question is not a gap", () => {
        const space = testSpace()
        const goal = from(space, { fragile: 1, noisy: 1 })
        const current = from(space, { fragile: 0 })
        expect(difference(space, goal, current).map(gap => gap.axis)).toEqual(["fragile"])
    })
})

describe("centroid", () => {
    test("averages over the members that measured each axis", () => {
        const space = testSpace()
        const result = centroid(space, [from(space, { threat: 0 }), from(space, { threat: 1 })])
        expect(read(space, result, "threat")?.value).toBeCloseTo(0.5, 6)
    })

    test("confidence is scaled by coverage — one opinion out of four is honestly weak", () => {
        const space = testSpace()
        const result = centroid(space, [
            from(space, { threat: 1, noisy: 1 }),
            from(space, { threat: 1 }),
            from(space, { threat: 1 }),
            from(space, { threat: 1 }),
        ])
        expect(read(space, result, "threat")?.confidence).toBeCloseTo(1, 6)
        expect(read(space, result, "noisy")?.confidence).toBeCloseTo(0.25, 6)
    })

    test("no members throws rather than returning the origin", () => {
        const space = testSpace()
        expect(() => centroid(space, [])).toThrow(/At Least One Coordinate|centroid/)
    })
})

describe("interpolate", () => {
    test("t=0 is a, t=1 is b, t=0.5 is halfway", () => {
        const space = testSpace()
        const a = from(space, { threat: 0 })
        const b = from(space, { threat: 1 })
        expect(read(space, interpolate(space, a, b, 0), "threat")?.value).toBeCloseTo(0, 6)
        expect(read(space, interpolate(space, a, b, 1), "threat")?.value).toBeCloseTo(1, 6)
        expect(read(space, interpolate(space, a, b, 0.5), "threat")?.value).toBeCloseTo(0.5, 6)
    })
})

describe("shift", () => {
    test("moves along a signed direction", () => {
        const space = testSpace()
        const result = shift(space, from(space, { threat: 0.5 }), [{ axis: "threat", gap: 0.2 }])
        expect(read(space, result, "threat")?.value).toBeCloseTo(0.7, 6)
    })

    test("a direction is signed, which is why it is not a Coord", () => {
        const space = testSpace()
        const result = shift(space, from(space, { threat: 0.5 }), [{ axis: "threat", gap: -0.2 }])
        expect(read(space, result, "threat")?.value).toBeCloseTo(0.3, 6)
    })

    test("clamps to the cube — membership beyond total membership has no meaning", () => {
        const space = testSpace()
        const up = shift(space, from(space, { threat: 0.9 }), [{ axis: "threat", gap: 0.5 }])
        const down = shift(space, from(space, { threat: 0.1 }), [{ axis: "threat", gap: -0.5 }])
        expect(read(space, up, "threat")?.value).toBe(1)
        expect(read(space, down, "threat")?.value).toBe(0)
    })

    test("factor scales how far it moves", () => {
        const space = testSpace()
        const result = shift(space, from(space, { threat: 0 }), [{ axis: "threat", gap: 1 }], 0.25)
        expect(read(space, result, "threat")?.value).toBeCloseTo(0.25, 6)
    })

    test("an axis the direction does not mention is left alone", () => {
        const space = testSpace()
        const result = shift(space, from(space, { threat: 0.5, noisy: 0.3 }), [{ axis: "threat", gap: 0.2 }])
        expect(read(space, result, "noisy")?.value).toBeCloseTo(0.3, 6)
    })

    test("an axis the position never measured cannot be pushed", () => {
        const space = testSpace()
        const result = shift(space, from(space, { threat: 0.5 }), [{ axis: "noisy", gap: 0.9 }])
        expect(read(space, result, "noisy")).toBeNull()
    })

    test("difference and shift compose — half way toward a goal in one line", () => {
        const space = testSpace()
        const goal = from(space, { threat: 1, fragile: 0 })
        const current = from(space, { threat: 0, fragile: 1 })

        const halfway = shift(space, current, difference(space, goal, current), 0.5)
        expect(read(space, halfway, "threat")?.value).toBeCloseTo(0.5, 5)
        expect(read(space, halfway, "fragile")?.value).toBeCloseTo(0.5, 5)
    })
})
