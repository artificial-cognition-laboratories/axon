import { describe, expect, it } from "bun:test"
import { named, world } from "../support/world"

const position = named<{ x: number }>("position")
const velocity = named<{ dx: number }>("velocity")

describe("Ecs: entities", () => {
    it("add() registers the entity once, emitting once", () => {
        const stage = world()
        stage.ecs.entity.add("e1")
        stage.ecs.entity.add("e1")
        expect(stage.ecs.entity.has("e1")).toBe(true)
        expect(stage.of("cognet:entity:add")).toHaveLength(1)
    })

    it("remove() cascades through every component, leaving other entities alone", () => {
        const stage = world()
        stage.ecs.entity.add("e1")
        stage.ecs.component.set("e1", position, { x: 1 })
        stage.ecs.component.set("e1", velocity, { dx: 1 })
        stage.ecs.component.set("e2", position, { x: 2 })

        stage.ecs.entity.remove("e1")

        expect(stage.ecs.entity.has("e1")).toBe(false)
        expect(stage.ecs.component.has("e1", position)).toBe(false)
        expect(stage.ecs.component.has("e1", velocity)).toBe(false)
        expect(stage.ecs.component.get("e2", position)).toEqual({ x: 2 })
        expect(stage.of("cognet:component:remove")).toHaveLength(2)
        expect(stage.of("cognet:entity:remove")).toHaveLength(1)
    })
})
