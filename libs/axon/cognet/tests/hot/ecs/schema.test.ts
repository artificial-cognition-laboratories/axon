import { describe, expect, it } from "bun:test"
import { Ecs } from "../../../src/ecs"

declare module "../../src/ecs" {
    interface ComponentRegistry {
        fear: { level: number }
        place: { x: number; y: number }
    }
}

type Emitted = { type: string; data: any }

function recorder() {
    const events: Emitted[] = []
    return {
        events: events,
        emit: ((type: string, data: unknown) => { events.push({ type: type, data: data }) }) as any,
    }
}

const stamp = () => ({ tick: 7, phase: "feel", system: "modulate" })

describe("Ecs: component declarations", () => {
    it("describes a component once, so a reader can render it before any value arrives", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.declare("fear", { domain: "point", shape: "scalar", unit: "normalized", range: [0, 1] })

        expect(sink.events).toEqual([
            {
                type: "cognet:component:declare",
                data: { component: "fear", domain: "point", shape: "scalar", unit: "normalized", range: [0, 1] },
            },
        ])
    })

    it("is idempotent — re-declaring identically does not restate it in the log", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.declare("fear", { domain: "point", shape: "scalar" })
        ecs.declare("fear", { domain: "point", shape: "scalar" })

        expect(sink.events).toHaveLength(1)
    })

    it("refuses a conflicting redeclaration rather than letting a shape change under a reader", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.declare("fear", { domain: "point", shape: "scalar" })

        expect(() => ecs.declare("fear", { domain: "point", shape: "vector" })).toThrow(/already declared with a different shape/)
    })
})

describe("Ecs: component writes", () => {
    it("carries the value, so the world is reconstructible from the log", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.62 } })

        expect(sink.events).toEqual([
            {
                type: "cognet:component:add",
                data: { tick: 7, phase: "feel", system: "modulate", entity: "self", component: "fear", rev: 1, value: { level: 0.62 } },
            },
        ])
    })

    it("emits nothing when the value did not change — the log records change, not repetition", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.62 } })
        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.62 } })

        expect(sink.events).toHaveLength(1)
    })

    it("gates structurally, not by reference — a fresh object with equal contents is not news", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.component.add({ entity: "self", type: "place", data: { x: 1, y: 2 } })
        ecs.component.add({ entity: "self", type: "place", data: { y: 2, x: 1 } })

        expect(sink.events).toHaveLength(1)
    })

    it("emits an update once the value actually changes", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.62 } })
        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.63 } })

        expect(sink.events.map(e => e.type)).toEqual(["cognet:component:add", "cognet:component:update"])
        expect(sink.events[1]!.data.value).toEqual({ level: 0.63 })
    })

    it("still updates the store and fires watchers on an unchanged write", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })
        const seen: unknown[] = []
        ecs.watch("fear", (_entity, data) => { seen.push(data) })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.5 } })
        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.5 } })

        expect(seen).toHaveLength(2)
        expect(ecs.component.get({ entity: "self", type: "fear" })).toEqual({ level: 0.5 })
    })
})

describe("Ecs: write times", () => {
    function clock() {
        let time = 1_000
        return {
            now: () => time,
            advance(ms: number) { time += ms },
        }
    }

    it("carries the time a belief was written", () => {
        const time = clock()
        const ecs = Ecs({ emit: () => {}, stamp: stamp, now: time.now })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.2 } })

        expect(ecs.component.writtenAt({ entity: "self", type: "fear" })).toBe(1_000)
    })

    /**
     * The distinction that makes staleness usable: a belief reaffirmed just now
     * is current even though nothing about it changed. Only advancing the time
     * on a CHANGE would make an unchanging belief look progressively more
     * doubtful the longer it stayed true.
     */
    it("advances the time on an unchanged write — reaffirmed is not stale", () => {
        const time = clock()
        const ecs = Ecs({ emit: () => {}, stamp: stamp, now: time.now })

        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.2 } })
        time.advance(500)
        ecs.component.add({ entity: "self", type: "fear", data: { level: 0.2 } })

        expect(ecs.component.writtenAt({ entity: "self", type: "fear" })).toBe(1_500)
    })

    it("has no time for a belief that was never written", () => {
        const ecs = Ecs({ emit: () => {}, stamp: stamp })

        expect(ecs.component.writtenAt({ entity: "self", type: "fear" })).toBeUndefined()
    })
})

describe("Ecs: the workspace flag", () => {
    it("separates what a mind may attend to from what it merely stores", () => {
        const ecs = Ecs({ emit: () => {}, stamp: stamp })

        ecs.declare("fear", { domain: "point", shape: "scalar", workspace: true })
        ecs.declare("place", { domain: "point", shape: "record" })

        const pool = ecs.schema.all().filter(entry => entry.descriptor.workspace)

        expect(pool.map(entry => entry.component)).toEqual(["fear"])
    })
})

describe("Ecs: frames", () => {
    /**
     * Frames are what make two beliefs layerable — depth over a camera image,
     * danger over a world map, coverage over a call graph. Declaring them by
     * name rather than picking from a fixed list of spatial words is what lets
     * an agent hold eight cameras, or a mind hold no physical space at all.
     */
    it("declares a space beliefs can be positioned in", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.frame("world", { kind: "metric2d", unit: "px", extent: [4200, 1200] })

        expect(sink.events).toEqual([
            { type: "cognet:frame:declare", data: { frame: "world", kind: "metric2d", unit: "px", extent: [4200, 1200] } },
        ])
    })

    it("accepts a frame that is not metric at all", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.frame("imports", { kind: "graph" })

        expect(ecs.schema.frames()).toEqual([{ frame: "imports", descriptor: { kind: "graph" } }])
    })

    it("is idempotent, and refuses a redeclaration that would move every belief in it", () => {
        const sink = recorder()
        const ecs = Ecs({ emit: sink.emit, stamp: stamp })

        ecs.frame("world", { kind: "metric2d" })
        ecs.frame("world", { kind: "metric2d" })
        expect(sink.events).toHaveLength(1)

        expect(() => ecs.frame("world", { kind: "metric3d" })).toThrow(/already declared with a different kind/)
    })
})
