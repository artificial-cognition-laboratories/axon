import { Ecs } from "../../src/ecs"

function Recorder() {
    const events: Array<{ event: string; payload: unknown }> = []
    return {
        events,
        emit: ((type: string, data: unknown) => { events.push({ event: type, payload: data }) }) as never,
    }
}


// Real module augmentation, same as a kernel system would declare —
// ComponentRegistry is intentionally empty until extended this way.
declare module "../../../../src/cognet/ecs" {
    interface ComponentRegistry {
        position: { x: number }
        velocity: { dx: number }
    }
}

describe("Ecs: entities", () => {
    it("add() registers the entity in the world", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.entity.add({ entity: "e1" })

        expect(ecs.state.entities.has("e1")).toBe(true)
    })

    it("add() with a single component attaches it via the component write path", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })

        expect(ecs.component.get({ entity: "e1", type: "position" })).toEqual({ x: 1 })
    })

    it("add() with multiple components attaches all of them", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.entity.add({
            entity: "e1",
            components: [
                { type: "position", data: { x: 1 } },
                { type: "velocity", data: { dx: 2 } },
            ],
        })

        expect(ecs.component.get({ entity: "e1", type: "position" })).toEqual({ x: 1 })
        expect(ecs.component.get({ entity: "e1", type: "velocity" })).toEqual({ dx: 2 })
    })

    it("remove() takes the entity out of the world", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1" })

        ecs.entity.remove({ entity: "e1" })

        expect(ecs.state.entities.has("e1")).toBe(false)
    })

    it("remove() cascades — every component the entity held is also removed", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })

        ecs.entity.remove({ entity: "e1" })

        expect(ecs.component.has({ entity: "e1", type: "position" })).toBe(false)
    })

    it("removing one entity's components does not affect another entity's components of the same type", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })
        ecs.entity.add({ entity: "e2", components: { type: "position", data: { x: 2 } } })

        ecs.entity.remove({ entity: "e1" })

        expect(ecs.component.has({ entity: "e2", type: "position" })).toBe(true)
        expect(ecs.component.get({ entity: "e2", type: "position" })).toEqual({ x: 2 })
    })

    it("emits cognet:entity:add and cognet:entity:remove on the bus", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit, stamp: () => ({ tick: 0, phase: null }) })

        ecs.entity.add({ entity: "e1" })
        ecs.entity.remove({ entity: "e1" })

        // bus.emit is fire-and-forget (void) inside Entity() — give the microtask queue a tick
        await Promise.resolve()

        const types = bus.events.map(e => e.event)
        expect(types).toContain("cognet:entity:add")
        expect(types).toContain("cognet:entity:remove")
    })

    it("removing an entity that was never added is a safe no-op", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        expect(() => ecs.entity.remove({ entity: "ghost" })).not.toThrow()
        expect(ecs.state.entities.has("ghost")).toBe(false)
    })
})
