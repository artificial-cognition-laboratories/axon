import { Ecs } from "../../src/ecs"
import { describe, it, expect } from "bun:test"

declare module "../../src/ecs" {
    interface ComponentRegistry {
        position: { x: number }
        velocity: { dx: number }
    }
}

describe("Ecs: watch", () => {
    it("fires synchronously when the watched component is written", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let seen: unknown = null

        ecs.watch("position", (entity, data) => { seen = { entity, data } })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        expect(seen).toEqual({ entity: "e1", data: { x: 1 } })
    })

    it("does not fire for writes to a different component type", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let calls = 0

        ecs.watch("position", () => { calls++ })
        ecs.component.add({ entity: "e1", type: "velocity", data: { dx: 1 } })

        expect(calls).toBe(0)
    })

    it("fires again on an update (second write), not just the first", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let calls = 0

        ecs.watch("position", () => { calls++ })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 2 } })

        expect(calls).toBe(2)
    })

    it("multiple watchers on the same type all fire", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let a = 0
        let b = 0

        ecs.watch("position", () => { a++ })
        ecs.watch("position", () => { b++ })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        expect(a).toBe(1)
        expect(b).toBe(1)
    })

    it("the returned unsubscribe function stops future notifications", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let calls = 0

        const unsubscribe = ecs.watch("position", () => { calls++ })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })
        unsubscribe()
        ecs.component.add({ entity: "e1", type: "position", data: { x: 2 } })

        expect(calls).toBe(1)
    })

    it("unsubscribing one watcher does not affect another watcher on the same type", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        let a = 0
        let b = 0

        const unsubA = ecs.watch("position", () => { a++ })
        ecs.watch("position", () => { b++ })
        unsubA()
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        expect(a).toBe(0)
        expect(b).toBe(1)
    })

    it("a throwing watcher propagates rather than being swallowed", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.watch("position", () => { throw new Error("watcher boom") })

        expect(() => ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })).toThrow("watcher boom")
    })

    it("does not fire on remove() — only on writes", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        let calls = 0
        ecs.watch("position", () => { calls++ })
        ecs.component.remove({ entity: "e1", type: "position" })

        expect(calls).toBe(0)
    })
})
