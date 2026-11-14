import { describe, expect, it } from "bun:test"
import { frame } from "../../../src/ecs"
import { named, namedFrame, world } from "../support/world"

describe("Ecs: component declarations", () => {
    it("declares a component from its handle's display, once", () => {
        const stage = world()
        const fear = named<number>("fear", { display: { domain: "point", shape: "scalar", range: [0, 1], workspace: true } })
        stage.ecs.schema.declare(fear)
        stage.ecs.schema.declare(fear)

        expect(stage.of("cognet:component:declare")).toEqual([{ component: "fear", domain: "point", shape: "scalar", range: [0, 1], workspace: true }])
        expect(stage.ecs.schema.get("fear")?.workspace).toBe(true)
    })

    it("declares nothing for a component with no display", () => {
        const stage = world()
        stage.ecs.schema.declare(named<number>("quiet"))
        expect(stage.of("cognet:component:declare")).toHaveLength(0)
    })

    it("requires physical metadata before declaring a cockpit instrument", () => {
        const stage = world()
        expect(() => stage.ecs.schema.declare(named<[number, number]>("motion", { display: { domain: "point", shape: "vector", unit: "m/s", instrument: "velocity" } }))).toThrow(/required shape, unit, frame or limits/)
        const body = namedFrame("body", { kind: "metric2d", unit: "m" })
        const valid = named<[number, number]>("velocity", { display: { domain: "point", shape: "vector", unit: "m/s", frame: body, labels: ["x", "y"], instrument: "velocity" } })
        stage.ecs.schema.declare(valid)
        expect(stage.of("cognet:component:declare")[0]).toMatchObject({ instrument: "velocity", frame: "body" })
    })
})

describe("Ecs: frames", () => {
    it("declares a frame by name, idempotently, and refuses a conflicting redeclaration", () => {
        const stage = world()
        const camera = namedFrame("eye/camera", { kind: "metric2d", unit: "px", extent: [160, 90] })
        stage.ecs.schema.frame(camera)
        stage.ecs.schema.frame(camera)
        expect(stage.of("cognet:frame:declare")).toEqual([{ frame: "eye/camera", kind: "metric2d", unit: "px", extent: [160, 90] }])
        expect(() => stage.ecs.schema.frame(namedFrame("eye/camera", { kind: "graph" }))).toThrow(/already declared/)
    })

    it("declares a frame's parent first, and names it", () => {
        const stage = world()
        const body = namedFrame("body", { kind: "metric2d", unit: "px" })
        stage.ecs.schema.frame(namedFrame("camera", { kind: "metric2d", unit: "px", relativeTo: body, scale: 4 }))
        expect(stage.of("cognet:frame:declare")).toEqual([
            { frame: "body", kind: "metric2d", unit: "px" },
            { frame: "camera", kind: "metric2d", unit: "px", relativeTo: "body", scale: 4 },
        ])
    })

    it("refuses a frame the compile step never named", () => {
        const stage = world()
        expect(() => stage.ecs.schema.frame(frame({ kind: "metric2d" }))).toThrow(/before the compile step named it/)
    })
})
