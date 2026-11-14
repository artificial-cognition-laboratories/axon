import { describe, expect, it } from "bun:test"
import { named, world } from "../support/world"

const position = named<{ x: number }>("position")
const velocity = named<{ dx: number }>("velocity")

describe("Ecs: watch", () => {
    it("fires synchronously on every write of the watched component, and only it", () => {
        const { ecs } = world()
        const seen: unknown[] = []
        ecs.watch(position, (entity, data) => seen.push([entity, data]))
        ecs.component.set("e1", position, { x: 1 })
        ecs.component.set("e1", position, { x: 2 })
        ecs.component.set("e1", velocity, { dx: 1 })
        expect(seen).toEqual([["e1", { x: 1 }], ["e1", { x: 2 }]])
    })

    it("stops after unsubscribe, and a throwing watcher propagates", () => {
        const { ecs } = world()
        let calls = 0
        const stop = ecs.watch(position, () => { calls++ })
        stop()
        ecs.component.set("e1", position, { x: 1 })
        expect(calls).toBe(0)

        ecs.watch(position, () => { throw new Error("boom") })
        expect(() => ecs.component.set("e1", position, { x: 2 })).toThrow("boom")
    })
})
