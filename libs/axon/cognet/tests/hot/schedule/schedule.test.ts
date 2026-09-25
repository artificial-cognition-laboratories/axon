import { describe, expect, it } from "bun:test"
import { Ecs, type ComponentType } from "../../../src/ecs"
import { Schedule, type ScheduleTrace, type SystemContext, type SystemSpec } from "../../../src/schedule"

/**
 * The schedule is the program: there is no call graph in an ECS, so what a
 * reader follows is data lineage. These assert that the lineage is coherent,
 * that an incoherent one refuses to run, and that it declares itself so a
 * debugger can draw it.
 */

declare module "../../src/ecs" {
    interface ComponentRegistry {
        body: { x: number }
        decision: { behaviour: string }
    }
}

function world(components: ComponentType[] = ["body", "fear", "decision"]) {
    const emitted: Array<{ type: string; data: unknown }> = []
    const ecs = Ecs({
        emit: ((type: string, data: unknown) => { emitted.push({ type: type, data: data }) }) as never,
        stamp: () => ({ tick: 0, phase: null, system: null }),
    })
    for (const component of components) ecs.declare(component, { domain: "point", shape: "scalar" })
    return { ecs: ecs, emitted: emitted, emit: ((type: string, data: unknown) => { emitted.push({ type: type, data: data }) }) as never }
}

/** Passthrough: these tests are about scheduling, not telemetry. */
const TRACE: ScheduleTrace = {
    phase: (_name, fn) => fn(),
    system: (_name, fn) => fn(),
}

function spec(over: Partial<SystemSpec> = {}): SystemSpec {
    return { name: "test", phase: "perceive", everyMs: 0, reads: [], writes: [], run: () => {}, ...over }
}

function schedule(systems: SystemSpec[], stage = world()) {
    return Schedule<SystemContext>({ ecs: stage.ecs, systems: systems, emit: stage.emit, trace: TRACE })
}

const PIPELINE = [
    spec({ name: "ingest", phase: "sense", writes: ["body"] }),
    spec({ name: "modulate", phase: "feel", reads: ["body"], writes: ["fear"] }),
    spec({ name: "flee", phase: "decide", reads: ["fear", "body"], writes: ["decision"] }),
]

describe("Schedule: validation", () => {
    it("is wiring only — an incoherent schedule constructs, and refuses on first run", async () => {
        const typo = schedule([spec({ name: "typo", writes: ["fearz" as never] })])
        await expect(typo.run({ now: 0 })).rejects.toThrow(/typo names "fearz", which the world has not declared/)
    })

    it("refuses a belief nothing writes — the read would be undefined forever", async () => {
        const orphan = schedule([spec({ name: "orphan", reads: ["fear"] })])
        await expect(orphan.run({ now: 0 })).rejects.toThrow(/orphan reads "fear", which no system writes/)
    })

    it("allows a system to read what it writes itself", async () => {
        const recursive = schedule([spec({ name: "recursive", reads: ["fear"], writes: ["fear"] })])
        await expect(recursive.run({ now: 0 })).resolves.toBeUndefined()
    })
})

describe("Schedule: lineage", () => {
    it("reports who produces and who consumes each belief", () => {
        const body = schedule(PIPELINE).lineage.graph().find(entry => entry.component === "body")!

        expect(body.writtenBy).toEqual(["ingest"])
        expect(body.readBy).toEqual(["modulate", "flee"])
    })

    it("declares itself once, on the first run, for a debugger to draw", async () => {
        const stage = world()
        const pipeline = schedule(PIPELINE, stage)
        const declarations = () => stage.emitted.filter(event => event.type === "cognet:schedule:declare")

        expect(declarations()).toHaveLength(0)

        await pipeline.run({ now: 0 })
        await pipeline.run({ now: 50 })

        expect(declarations()).toHaveLength(1)
        expect(declarations()[0]!.data).toEqual({
            systems: [
                { name: "ingest", phase: "sense", everyMs: 0, reads: [], writes: ["body"] },
                { name: "modulate", phase: "feel", everyMs: 0, reads: ["body"], writes: ["fear"] },
                { name: "flee", phase: "decide", everyMs: 0, reads: ["fear", "body"], writes: ["decision"] },
            ],
        })
    })

    it("does not declare a schedule that failed its check", async () => {
        const stage = world()
        await expect(schedule([spec({ reads: ["fear"] })], stage).run({ now: 0 })).rejects.toThrow()
        expect(stage.emitted.some(event => event.type === "cognet:schedule:declare")).toBe(false)
    })
})

describe("Schedule: observed reads", () => {
    it("records exactly which change of each value a system read", async () => {
        const stage = world()
        const pipeline = schedule([
            spec({ name: "ingest", phase: "sense", writes: ["body"], run: () => stage.ecs.component.add({ entity: "self", type: "body", data: { x: 1 } }) }),
            spec({ name: "modulate", phase: "feel", reads: ["body"], writes: ["fear"], run: () => {
                const body = stage.ecs.component.get({ entity: "self", type: "body" })
                stage.ecs.component.add({ entity: "self", type: "fear", data: { level: body!.x } })
            } }),
        ], stage)

        await pipeline.run({ now: 0 })

        const bodyRev = (stage.emitted.find(event => event.type === "cognet:component:add" && (event.data as { component: string }).component === "body")!.data as { rev: number }).rev
        const reads = stage.emitted.filter(event => event.type === "cognet:system:reads").map(event => event.data as { system: string; reads: unknown[] })

        expect(reads).toEqual([
            expect.objectContaining({ system: "ingest", reads: [] }),
            expect.objectContaining({ system: "modulate", reads: [{ entity: "self", component: "body", rev: bodyRev }] }),
        ])
    })

    it("points a reader at the change it saw, not a reaffirmation after it", async () => {
        const stage = world()
        stage.ecs.component.add({ entity: "self", type: "body", data: { x: 1 } })
        stage.ecs.component.add({ entity: "self", type: "body", data: { x: 1 } })

        const { reads } = stage.ecs.observe(() => stage.ecs.component.get({ entity: "self", type: "body" }))
        const added = stage.emitted.filter(event => event.type === "cognet:component:add" || event.type === "cognet:component:update")

        expect(added).toHaveLength(1)
        expect(reads[0]!.rev).toBe((added[0]!.data as { rev: number }).rev)
    })

    it("records what a query handed back", () => {
        const stage = world()
        stage.ecs.component.add({ entity: "a", type: "decision", data: { behaviour: "flee" } })
        stage.ecs.component.add({ entity: "b", type: "decision", data: { behaviour: "wander" } })

        const { reads } = stage.ecs.observe(() => stage.ecs.query({ with: ["decision"], filter: entry => entry.entity === "a" }))

        expect(reads.map(read => read.entity)).toEqual(["a"])
    })
})

describe("Schedule: rates", () => {
    it("runs an everyMs:0 system every tick", async () => {
        let runs = 0
        const every = schedule([spec({ everyMs: 0, run: () => { runs++ } })])

        await every.run({ now: 0 })
        await every.run({ now: 50 })
        await every.run({ now: 100 })

        expect(runs).toBe(3)
    })

    it("holds a slower system back until it is due", async () => {
        let runs = 0
        const slow = schedule([spec({ everyMs: 100, run: () => { runs++ } })])

        await slow.run({ now: 0 })
        await slow.run({ now: 50 })
        expect(runs).toBe(1)

        await slow.run({ now: 100 })
        expect(runs).toBe(2)
    })

    it("hands every system the tick's own context", async () => {
        type Ctx = SystemContext & { stimuli: string[] }
        const seen: string[][] = []
        const stage = world()
        const typed = Schedule<Ctx>({
            ecs: stage.ecs,
            systems: [{ name: "see", phase: "sense", everyMs: 0, reads: [], writes: [], run: ctx => { seen.push(ctx.stimuli) } }],
            emit: stage.emit,
            trace: TRACE,
        })

        await typed.run({ now: 0, stimuli: ["frame"] })

        expect(seen).toEqual([["frame"]])
    })
})
