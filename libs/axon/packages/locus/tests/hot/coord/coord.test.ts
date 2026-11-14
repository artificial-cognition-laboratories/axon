import { describe, expect, test } from "bun:test"
import { claims, coord, empty, from, measured, read, assertBasis } from "../../../src/pure"
import { grownSpace, testSpace } from "../../space"

describe("coord", () => {
    test("unsupplied axes are unmeasured, not zero", () => {
        const space = testSpace()
        const position = from(space, { threat: 0.8 })

        const threat = read(space, position, "threat")!
        expect(threat.value).toBeCloseTo(0.8, 6)
        expect(threat.confidence).toBe(1)
        expect(read(space, position, "noisy")).toBeNull()
        expect(measured(space, position, "noisy")).toBe(false)
    })

    test("a measured zero is a claim, and reads back as one", () => {
        const space = testSpace()
        const position = from(space, { noisy: 0 })

        expect(measured(space, position, "noisy")).toBe(true)
        expect(read(space, position, "noisy")).toEqual({ value: 0, confidence: 1 })
        // exact here only because 0 and 1 are representable in Float32
    })

    test("claims lists only what the position actually asserts", () => {
        const space = testSpace()
        const position = from(space, { threat: 0.8, noisy: 0 })
        expect(claims(space, position).sort()).toEqual(["noisy", "threat"])
    })

    test("empty claims nothing", () => {
        const space = testSpace()
        expect(claims(space, empty(space))).toEqual([])
    })

    test("confidence is carried per component", () => {
        const space = testSpace()
        const position = from(space, { threat: { value: 0.7, confidence: 0.4 } })
        const threat = read(space, position, "threat")!
        expect(threat.value).toBeCloseTo(0.7, 6)
        expect(threat.confidence).toBeCloseTo(0.4, 6)
    })

    test("two producers writing one axis throws", () => {
        const space = testSpace()
        expect(() =>
            coord(space, [
                ["threat", { value: 0.1, confidence: 1 }],
                ["threat", { value: 0.9, confidence: 1 }],
            ])
        ).toThrow(/Written Twice|threat/)
    })

    test("an unknown axis throws at construction", () => {
        const space = testSpace()
        expect(() => from(space, { wealth: 0.5 })).toThrow(/Unknown Axis|wealth/)
    })

    test("a position is frozen — a point does not move", () => {
        const space = testSpace()
        const position = from(space, { threat: 0.5 })
        expect(Object.isFrozen(position)).toBe(true)
    })

    test("a coordinate from another basis is rejected", () => {
        const space = testSpace()
        const grown = grownSpace()
        const position = from(space, { threat: 0.5 })
        expect(() => assertBasis(grown, position)).toThrow(/Different Basis|basis/)
    })
})
