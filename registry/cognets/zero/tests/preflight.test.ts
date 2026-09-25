import { describe, expect, test } from "bun:test"
import { ZERO_PREFLIGHT } from "../src/preflight"

describe("Zero preflight", () => {
    test("is a compact primer rather than a second conversation", () => {
        expect(ZERO_PREFLIGHT).toHaveLength(15)
        expect(JSON.stringify(ZERO_PREFLIGHT).length).toBeLessThan(2_500)
    })

    test("demonstrates action, answer, and changed approach", () => {
        const scripts = ZERO_PREFLIGHT.filter(turn => turn.kind === "script")
        const results = ZERO_PREFLIGHT.filter(turn => turn.kind === "stdout")

        expect(scripts.map(turn => turn.id)).toEqual(["p1", "p2", "p3"])
        expect(results.map(turn => turn.for)).toEqual(["p1", "p2", "p3"])
        expect(results.find(turn => turn.for === "p2")?.ok).toBe(false)
    })

    test("contains no static interrupt or policy trajectory", () => {
        expect(ZERO_PREFLIGHT.some(turn => turn.kind === "interrupt")).toBe(false)
        expect(JSON.stringify(ZERO_PREFLIGHT)).not.toContain("denied by policy")
    })
})
