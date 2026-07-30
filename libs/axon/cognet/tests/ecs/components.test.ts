import { Ecs } from "../../src/ecs"

function Recorder() {
    const events: Array<{ event: string; payload: unknown }> = []
    return {
        events,
        emit: ((type: string, data: unknown) => { events.push({ event: type, payload: data }) }) as never,
    }
}


declare module "../../../../src/cognet/ecs" {
    interface ComponentRegistry {
        position: { x: number }
        velocity: { dx: number }
    }
}

describe("Ecs: components", () => {
    it("add() then get() returns the stored data", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        expect(ecs.component.get({ entity: "e1", type: "position" })).toEqual({ x: 1 })
    })

    it("has() is true after add(), false before it", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        expect(ecs.component.has({ entity: "e1", type: "position" })).toBe(false)
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })
        expect(ecs.component.has({ entity: "e1", type: "position" })).toBe(true)
    })

    it("get() on an entity with no such component returns undefined", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        expect(ecs.component.get({ entity: "e1", type: "position" })).toBeUndefined()
    })

    it("add() again on the same entity+type overwrites the data", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 2 } })

        expect(ecs.component.get({ entity: "e1", type: "position" })).toEqual({ x: 2 })
    })

    it("remove() clears the component; get() and has() reflect it", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        ecs.component.remove({ entity: "e1", type: "position" })

        expect(ecs.component.has({ entity: "e1", type: "position" })).toBe(false)
        expect(ecs.component.get({ entity: "e1", type: "position" })).toBeUndefined()
    })

    it("removing a component that was never added is a safe no-op", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        expect(() => ecs.component.remove({ entity: "e1", type: "position" })).not.toThrow()
    })

    it("components are isolated per type — adding 'position' doesn't affect 'velocity'", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        expect(ecs.component.has({ entity: "e1", type: "velocity" })).toBe(false)
    })

    it("emits cognet:component:add on first write, cognet:component:update on a second write to the same entity+type", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit, stamp: () => ({ tick: 0, phase: null }) })

        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 2 } })
        await Promise.resolve()

        const types = bus.events.map(e => e.event)
        expect(types.filter(t => t === "cognet:component:add").length).toBe(1)
        expect(types.filter(t => t === "cognet:component:update").length).toBe(1)
    })

    it("emits kernel:component:remove on remove()", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit, stamp: () => ({ tick: 0, phase: null }) })
        ecs.component.add({ entity: "e1", type: "position", data: { x: 1 } })

        ecs.component.remove({ entity: "e1", type: "position" })
        await Promise.resolve()

        expect(bus.events.map(e => e.event)).toContain("cognet:component:remove")
    })

    it("does not emit kernel:component:remove when removing something that was never added", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit, stamp: () => ({ tick: 0, phase: null }) })

        ecs.component.remove({ entity: "e1", type: "position" })
        await Promise.resolve()

        expect(bus.events.map(e => e.event)).not.toContain("cognet:component:remove")
    })
})
