import { describe, expect, it } from "bun:test"
import { component } from "../../../src/ecs"
import { named, world } from "../support/world"

const position = named<{ x: number }>("position")
const velocity = named<{ dx: number }>("velocity")

describe("Ecs: components", () => {
    it("set() then get() returns the stored data, typed by the handle", () => {
        const { ecs } = world()
        ecs.component.set("e1", position, { x: 1 })
        expect(ecs.component.get("e1", position)).toEqual({ x: 1 })
    })

    it("has() is true after set(), false before it", () => {
        const { ecs } = world()
        expect(ecs.component.has("e1", position)).toBe(false)
        ecs.component.set("e1", position, { x: 1 })
        expect(ecs.component.has("e1", position)).toBe(true)
    })

    it("set() again overwrites, and components are isolated per handle", () => {
        const { ecs } = world()
        ecs.component.set("e1", position, { x: 1 })
        ecs.component.set("e1", position, { x: 2 })
        expect(ecs.component.get("e1", position)).toEqual({ x: 2 })
        expect(ecs.component.get("e1", velocity)).toBeUndefined()
    })

    it("remove() clears it, and removing what was never set is a no-op with no event", () => {
        const stage = world()
        stage.ecs.component.remove("e1", position)
        expect(stage.of("cognet:component:remove")).toHaveLength(0)

        stage.ecs.component.set("e1", position, { x: 1 })
        stage.ecs.component.remove("e1", position)
        expect(stage.ecs.component.has("e1", position)).toBe(false)
        expect(stage.of("cognet:component:remove")).toHaveLength(1)
    })

    it("all() lists every holder, in entity order", () => {
        const { ecs } = world()
        ecs.component.set("b", position, { x: 2 })
        ecs.component.set("a", position, { x: 1 })
        expect(ecs.component.all(position)).toEqual([{ entity: "a", value: { x: 1 } }, { entity: "b", value: { x: 2 } }])
    })

    it("a handle the compile step never named throws on first use", () => {
        const { ecs } = world()
        const stray = component<number>()
        expect(() => ecs.component.set("e1", stray, 1)).toThrow(/before the compile step named it/)
    })
})

describe("Ecs: component writes", () => {
    it("emits add then update, carrying the value and its rev", () => {
        const stage = world()
        stage.ecs.component.set("e1", position, { x: 1 })
        stage.ecs.component.set("e1", position, { x: 2 })
        const [added] = stage.of("cognet:component:add")
        const [updated] = stage.of("cognet:component:update")
        expect(added).toMatchObject({ entity: "e1", component: "position", value: { x: 1 } })
        expect(updated).toMatchObject({ entity: "e1", component: "position", value: { x: 2 } })
        expect(updated.rev).toBeGreaterThan(added.rev)
    })

    it("emits nothing for a structurally equal write, but still updates the store", () => {
        const stage = world()
        stage.ecs.component.set("e1", position, { x: 1 })
        stage.ecs.component.set("e1", position, { x: 1 })
        expect(stage.of("cognet:component:update")).toHaveLength(0)
        expect(stage.ecs.component.get("e1", position)).toEqual({ x: 1 })
    })

    it("records a heavy value as a digest of its arrays, never their bytes", () => {
        const stage = world()
        const cloud = named<{ seq: number; points: Float32Array }>("cloud")
        stage.ecs.component.set("e1", cloud, { seq: 3, points: new Float32Array(2_000) })
        expect(stage.ecs.component.get("e1", cloud)?.points).toHaveLength(2_000)
        const [added] = stage.of("cognet:component:add")
        expect(added?.value).toEqual({ seq: 3, points: { $digest: { kind: "f32", length: 2_000 } } })
    })

    it("treats every heavy write as a change, without comparing the value", () => {
        const stage = world()
        const map = named<Float32Array>("map")
        const first = new Float32Array(2_000)
        const second = new Float32Array(2_000)
        stage.ecs.component.set("e1", map, first)
        stage.ecs.component.set("e1", map, second)
        // An equal value still replaces the stored one, and is recorded: it was not compared.
        expect(stage.ecs.component.get("e1", map)).toBe(second)
        expect(stage.of("cognet:component:update")).toHaveLength(1)
    })

    it("records a light value whole, arrays included", () => {
        const stage = world()
        const covariance = named<Float64Array>("covariance")
        stage.ecs.component.set("e1", covariance, new Float64Array(36))
        expect(stage.of("cognet:component:add")[0]?.value).toEqual(new Float64Array(36))
    })

    it("compares typed arrays by content", () => {
        const stage = world()
        const mask = named<Float32Array>("mask")
        stage.ecs.component.set("e1", mask, new Float32Array([1, 2]))
        stage.ecs.component.set("e1", mask, new Float32Array([1, 2]))
        expect(stage.of("cognet:component:update")).toHaveLength(0)
        stage.ecs.component.set("e1", mask, new Float32Array([1, 3]))
        expect(stage.of("cognet:component:update")).toHaveLength(1)
    })
})

describe("Ecs: write times", () => {
    it("carries the write time, and advances it on an unchanged write", () => {
        let now = 1000
        const { ecs } = world({ now: () => now })
        expect(ecs.component.writtenAt("e1", position)).toBeUndefined()
        ecs.component.set("e1", position, { x: 1 })
        expect(ecs.component.writtenAt("e1", position)).toBe(1000)
        now = 2000
        ecs.component.set("e1", position, { x: 1 })
        expect(ecs.component.writtenAt("e1", position)).toBe(2000)
    })
})

describe("Ecs: observation", () => {
    it("records every read and write a run makes", () => {
        const { ecs } = world()
        ecs.component.set("e1", position, { x: 1 })
        const observed = ecs.observe(() => {
            ecs.component.get("e1", position)
            ecs.component.set("e1", velocity, { dx: 1 })
        })
        expect(observed.reads.map(read => read.component)).toEqual(["position"])
        expect(observed.writes).toEqual([{ entity: "e1", component: "velocity" }])
    })

    it("refuses to nest", () => {
        const { ecs } = world()
        expect(() => ecs.observe(() => ecs.observe(() => {}))).toThrow(/already recording/)
    })
})

describe("Ecs: isolation", () => {
    it("routes `ecs` inside an isolated run to its snapshot and buffer", async () => {
        const { ecs } = world()
        ecs.component.set("self", position, { x: 1 })
        const view = ecs.isolate({ system: "think", reads: new Set(["position", "velocity"]), writes: new Set(["velocity"]) })

        ecs.component.set("self", position, { x: 2 })
        const read = await view.run(async () => {
            await Promise.resolve()
            ecs.component.set("self", velocity, { dx: 5 })
            return [ecs.component.get("self", position), ecs.component.get("self", velocity)]
        })

        expect(read).toEqual([{ x: 1 }, { dx: 5 }])
        expect(ecs.component.get("self", velocity)).toBeUndefined()
        view.commit()
        expect(ecs.component.get("self", velocity)).toEqual({ dx: 5 })
    })

    it("refuses to remove an entity holding a component the run may not write", () => {
        const { ecs } = world()
        ecs.component.set("thing", position, { x: 1 })
        ecs.component.set("thing", velocity, { dx: 1 })
        const view = ecs.isolate({ system: "tidy", reads: new Set(["velocity"]), writes: new Set(["velocity"]) })

        view.run(() => ecs.entity.remove("thing"))
        expect(() => view.commit()).toThrow(/tidy wrote "position" without declaring it/)
    })
})
