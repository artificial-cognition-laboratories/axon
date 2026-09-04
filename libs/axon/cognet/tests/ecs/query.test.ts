import { Ecs } from "../../src/ecs"
import { describe, it, expect } from "bun:test"

declare module "../../src/ecs" {
    interface ComponentRegistry {
        position: { x: number }
        velocity: { dx: number }
        tag: string
    }
}

describe("Ecs: query", () => {
    it("with: returns entities that have all the listed components, plus their data", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: [{ type: "position", data: { x: 1 } }, { type: "velocity", data: { dx: 2 } }] })
        ecs.entity.add({ entity: "e2", components: { type: "position", data: { x: 3 } } })

        const results = ecs.query({ with: ["position", "velocity"] })

        expect(results).toEqual([{ entity: "e1", components: { position: { x: 1 }, velocity: { dx: 2 } } }])
    })

    it("with: on a component type nobody has returns an empty array immediately", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })

        expect(ecs.query({ with: ["velocity"] })).toEqual([])
    })

    it("without: excludes entities that have the listed component", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: [{ type: "position", data: { x: 1 } }, { type: "velocity", data: { dx: 1 } }] })
        ecs.entity.add({ entity: "e2", components: { type: "position", data: { x: 2 } } })

        const results = ecs.query({ with: ["position"], without: ["velocity"] })

        expect(results.map(r => r.entity)).toEqual(["e2"])
    })

    it("where: matches only entities whose component value is === the expected value", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "tag", data: "friend" } })
        ecs.entity.add({ entity: "e2", components: { type: "tag", data: "foe" } })

        const results = ecs.query({ with: ["tag"], where: { tag: "friend" } })

        expect(results.map(r => r.entity)).toEqual(["e1"])
    })

    it("where: uses reference equality — an equivalent but distinct object does not match", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })

        const results = ecs.query({ with: ["position"], where: { position: { x: 1 } } })

        expect(results).toEqual([])
    })

    it("filter: applies a predicate over the already-queried entries", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })
        ecs.entity.add({ entity: "e2", components: { type: "position", data: { x: 5 } } })

        const results = ecs.query({ with: ["position"], filter: e => e.components.position.x > 2 })

        expect(results.map(r => r.entity)).toEqual(["e2"])
    })

    it("with no with/without/where/filter, returns every entity that has any component at all", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: { type: "position", data: { x: 1 } } })
        ecs.entity.add({ entity: "e2" }) // no components

        const results = ecs.query({})

        expect(results.map(r => r.entity)).toEqual(["e1"])
    })

    it("combines with, without, and where together", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })
        ecs.entity.add({ entity: "e1", components: [{ type: "position", data: { x: 1 } }, { type: "tag", data: "friend" }] })
        ecs.entity.add({ entity: "e2", components: [{ type: "position", data: { x: 1 } }, { type: "tag", data: "foe" }, { type: "velocity", data: { dx: 1 } }] })
        ecs.entity.add({ entity: "e3", components: { type: "tag", data: "friend" } })

        const results = ecs.query({ with: ["position", "tag"], without: ["velocity"], where: { tag: "friend" } })

        expect(results.map(r => r.entity)).toEqual(["e1"])
    })

    it("querying an empty world returns an empty array", () => {
        const ecs = Ecs({ emit: () => {}, stamp: () => ({ tick: 0, phase: null }) })

        expect(ecs.query({ with: ["position"] })).toEqual([])
        expect(ecs.query({})).toEqual([])
    })
})
