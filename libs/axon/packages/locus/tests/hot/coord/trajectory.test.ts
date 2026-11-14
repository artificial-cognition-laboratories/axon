import { describe, expect, test } from "bun:test"
import { from, trajectory } from "../../../src/pure"
import { testSpace } from "../../space"

const space = testSpace()

/** A walk that holds still, jumps, then holds still again. */
function stepped() {
    return [
        from(space, { threat: 0, fragile: 0 }),
        from(space, { threat: 0.05, fragile: 0 }),
        from(space, { threat: 0.9, fragile: 0 }),
        from(space, { threat: 0.92, fragile: 0 }),
    ]
}

describe("trajectory", () => {
    test("velocity spikes where the situation shifted", () => {
        const v = trajectory(space, stepped(), { domain: "risk" }).velocity()
        expect(v).toHaveLength(3)
        expect(v[1]!).toBeGreaterThan(v[0]!)
        expect(v[1]!).toBeGreaterThan(v[2]!)
    })

    test("acceleration is the change in velocity", () => {
        const t = trajectory(space, stepped(), { domain: "risk" })
        expect(t.acceleration()).toHaveLength(2)
    })

    test("drift measures start to end, not the path taken", () => {
        const there = from(space, { threat: 0, fragile: 0 })
        const away = from(space, { threat: 1, fragile: 1 })
        const returned = trajectory(space, [there, away, there], { domain: "risk" })
        expect(returned.drift()).toBeCloseTo(0, 5)
        expect(returned.velocity()[0]!).toBeGreaterThan(0.5)
    })

    test("isLooping ignores adjacent steps, so a smooth walk is not a loop", () => {
        const walk = [
            from(space, { threat: 0, fragile: 0 }),
            from(space, { threat: 0.3, fragile: 0 }),
            from(space, { threat: 0.6, fragile: 0 }),
            from(space, { threat: 0.9, fragile: 0 }),
        ]
        expect(trajectory(space, walk, { domain: "risk" }).isLooping(0.1)).toBe(false)
    })

    test("isLooping catches a return to ground already covered", () => {
        const loop = [
            from(space, { threat: 0, fragile: 0 }),
            from(space, { threat: 0.9, fragile: 0 }),
            from(space, { threat: 0, fragile: 0 }),
        ]
        expect(trajectory(space, loop, { domain: "risk" }).isLooping(0.05)).toBe(true)
    })

    test("isSettling compares the second half against the first", () => {
        const settling = [
            from(space, { threat: 0, fragile: 0 }),
            from(space, { threat: 0.8, fragile: 0 }),
            from(space, { threat: 0.82, fragile: 0 }),
            from(space, { threat: 0.83, fragile: 0 }),
        ]
        expect(trajectory(space, settling, { domain: "risk" }).isSettling()).toBe(true)
    })

    test("slice is composable", () => {
        const t = trajectory(space, stepped(), { domain: "risk" })
        expect(t.slice(0, 2).velocity()).toHaveLength(1)
    })

    test("a single position has no motion", () => {
        const t = trajectory(space, [from(space, { threat: 0.5 })], { domain: "risk" })
        expect(t.velocity()).toEqual([])
        expect(t.drift()).toBe(0)
        expect(t.isLooping()).toBe(false)
    })
})
