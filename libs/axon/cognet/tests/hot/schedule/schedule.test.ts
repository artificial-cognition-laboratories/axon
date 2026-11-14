import { describe, expect, it } from "bun:test"
import type { Component, Definition } from "../../../src/ecs"
import type { AxonStimulusEntry } from "@arcforge/types"
import { clock, defineSystem, Schedule, stimuli, type NamedSystem, type ScheduleTrace, type SystemSpec } from "../../../src/schedule"
import { named, namedQuery, world } from "../support/world"
import { Clock } from "../../../src/clock"
import { Ticks } from "../../../src/ticks"

/**
 * The schedule is the program: there is no call graph in an ECS. These assert
 * that its order is derived from data alone, that an incoherent one refuses to
 * run, and that a run cannot step outside what it declared.
 */

const TRACE: ScheduleTrace = { tick: fn => fn(() => {}), system: (_name, fn) => fn(() => {}) }

/** A system; one that reads nothing and names no trigger runs every tick, as the fixtures here mean it to. */
function sys(name: string, spec: Partial<SystemSpec> = {}): NamedSystem {
    const ticking = !spec.on && !(spec.reads && spec.reads.length > 0) && !spec.once
    return { name: name, system: defineSystem({ run: () => {}, ...(ticking ? { on: [clock] } : {}), ...spec }) }
}

/** A schedule over a stage, traced by a real clock — so each run's record, reads and all, reaches the stage. */
function schedule(systems: NamedSystem[], stage = world(), hz?: number) {
    const clock = Clock({ ticks: Ticks(), emit: stage.emit })
    const trace: ScheduleTrace = { tick: (fn, opened) => clock.runTick(fn, opened), system: (name, fn, ran) => clock.runSystem(name, fn, ran) }
    return { stage: stage, schedule: Schedule({ ecs: stage.ecs, systems: systems, emit: stage.emit, trace: trace, hz: hz }) }
}

/** Each system run the stage recorded. */
function runs(stage: ReturnType<typeof world>): any[] {
    return stage.of("cognet:system:run")
}

/** A stimulus stand-in: the schedule buffers entries, it never inspects them. Labelled so a test can tell them apart. */
const labels = new Map<AxonStimulusEntry, number>()
function stimulus(label: number): AxonStimulusEntry {
    const entry = { type: "cognet:stimulus:vector", time: { ms: label, seq: 100 + label }, data: { channel: "/body", values: [label] } } as unknown as AxonStimulusEntry
    labels.set(entry, label)
    return entry
}
function labelled(entries: readonly AxonStimulusEntry[]): number[] {
    return entries.map(entry => {
        const label = labels.get(entry)
        if (label === undefined) throw new Error("an unlabelled stimulus reached a system")
        return label
    })
}

const SIGNAL = new AbortController().signal

/** One tick's input, as the host hands it over. */
function at(now: number, stimuli: AxonStimulusEntry[] = [], signal = SIGNAL) {
    return { now: now, stimuli: stimuli, signal: signal }
}

const TICK = at(0)

function names(systems: NamedSystem[]): string[] {
    return systems.map(entry => entry.name)
}

describe("Schedule: order", () => {
    const body = named<number>("body/body")
    const fear = named<number>("feel/fear")
    const decision = named<string>("decide/decision")

    const pipeline = [
        sys("decide/flee", { reads: [fear, body], writes: [decision] }),
        sys("feel/modulate", { reads: [body], writes: [fear] }),
        sys("body/ingest", { writes: [body] }),
    ]

    it("runs every writer before its readers, whatever order the systems arrive in", () => {
        const expected = ["body/ingest", "feel/modulate", "decide/flee"]
        expect(names(schedule(pipeline).schedule.lineage.order())).toEqual(expected)
        expect(names(schedule([...pipeline].reverse()).schedule.lineage.order())).toEqual(expected)
    })

    it("breaks ties by name, so unrelated systems have one fixed order", () => {
        const a = named<number>("a")
        const b = named<number>("b")
        const order = schedule([sys("zeta", { writes: [a] }), sys("alpha", { writes: [b] })]).schedule.lineage.order()
        expect(names(order)).toEqual(["alpha", "zeta"])
    })

    it("names a cycle even when the first stuck system is only downstream of it", async () => {
        const a = named<number>("a")
        const b = named<number>("b")
        const c = named<number>("c")
        // "after" reads the loop's output: stuck, but not IN the loop, and first by name.
        const systems = [sys("after", { reads: [b], writes: [c] }), sys("one", { reads: [b], writes: [a] }), sys("two", { reads: [a], writes: [b] })]
        await expect(schedule(systems).schedule.run(TICK)).rejects.toThrow(/cycle: one → two → one/)
    })

    it("refuses a cycle, naming it", async () => {
        const flow = named<number>("flow")
        const ego = named<number>("ego")
        const { schedule: loop } = schedule([
            sys("flow", { reads: [ego], writes: [flow] }),
            sys("ego", { reads: [flow], writes: [ego] }),
        ])
        await expect(loop.run(TICK)).rejects.toThrow(/cycle: ego → flow → ego.*recalls/)
    })

    it("lets `recalls` close a feedback loop without an ordering edge", () => {
        const flow = named<number>("flow")
        const ego = named<number>("ego")
        const order = schedule([
            sys("flow", { recalls: [ego], writes: [flow] }),
            sys("ego", { reads: [flow], writes: [ego] }),
        ]).schedule.lineage.order()
        expect(names(order)).toEqual(["flow", "ego"])
    })

    it("orders by a query's members", () => {
        const place = named<number>("place")
        const travel = named<number>("travel")
        const tracked = namedQuery("tracked", { place: place, travel: travel })
        const order = schedule([
            sys("flee", { reads: [tracked] }),
            sys("travel", { writes: [travel] }),
            sys("place", { writes: [place] }),
        ]).schedule.lineage.order()
        expect(names(order)).toEqual(["place", "travel", "flee"])
    })
})

describe("Schedule: what may overlap", () => {
    it("waits only for earlier systems that write what it sees, or see what it writes", () => {
        const frame = named<number>("frame")
        const flow = named<number>("flow")
        const map = named<number>("map")
        const { schedule: built } = schedule([
            sys("sense", { writes: [frame] }),
            sys("flow", { reads: [frame], writes: [flow] }),
            sys("map", { reads: [frame], writes: [map] }),
            sys("steer", { reads: [flow, map] }),
        ])
        built.lineage.check()
        const waits = built.lineage.waits()
        expect(waits.get("flow")).toEqual(["sense"])
        expect(waits.get("map")).toEqual(["sense"])
        expect(waits.get("steer")).toEqual(["flow", "map"])
    })

    it("keeps a recaller on its side of the writer, so which tick it sees never depends on timing", () => {
        const pose = named<number>("pose")
        const { schedule: built } = schedule([
            sys("a/predict", { recalls: [pose] }),
            sys("b/odometry", { writes: [pose] }),
        ])
        built.lineage.check()
        expect(names(built.lineage.order())).toEqual(["a/predict", "b/odometry"])
        expect(built.lineage.waits().get("b/odometry")).toEqual(["a/predict"])
    })
})

describe("Schedule: validation", () => {
    async function refuses(systems: NamedSystem[], pattern: RegExp) {
        await expect(schedule(systems).schedule.run(TICK)).rejects.toThrow(pattern)
    }

    it("refuses an async worker system, and a worker system reading stimuli", async () => {
        const out = named<number>("out")
        await refuses([sys("think", { thread: "worker", writes: [out], run: async () => {} })], /think is `async` and `thread: "worker"`/)
        await refuses([sys("hear", { thread: "worker", reads: [stimuli], writes: [out] })], /hear reads stimuli on a worker thread/)
    })

    it("refuses a read nothing writes", async () => {
        const fear = named<number>("fear")
        await refuses([sys("orphan", { reads: [fear] })], /orphan reads "fear", which no system writes/)
    })

    it("allows a system to read what it writes", async () => {
        const fear = named<number>("fear")
        await expect(schedule([sys("self", { reads: [fear], writes: [fear] })]).schedule.run(TICK)).resolves.toBeUndefined()
    })

    it("refuses two writers of one component", async () => {
        const fear = named<number>("fear")
        await refuses([sys("a", { writes: [fear] }), sys("b", { writes: [fear] })], /"fear" is written by a and b/)
    })

    it("refuses a system nothing could run, or nothing ever would", async () => {
        const out = named<number>("out")
        const beat = named<number>("beat")
        const idle = (spec: Partial<SystemSpec>) => ({ name: "idle", system: defineSystem({ run: () => {}, ...spec }) })
        await refuses([idle({ writes: [out] })], /idle reads nothing and names nothing in `on` — it would run once and never again/)
        await refuses([idle({ on: [], writes: [out] })], /idle has `on: \[\]` — nothing would ever run it/)
        await refuses([idle({ reads: [clock], writes: [out] })], /idle reads the clock — it carries nothing to read/)
        await refuses([idle({ on: [stimuli], writes: [out] })], /idle is run by stimuli it does not read/)
        await refuses([idle({ on: [beat], writes: [out] })], /idle is run by "beat", which no system writes — it would never run/)
        // A mind with no clock waits for its async work each wake: one the clock restarts would hold it forever.
        await refuses([idle({ on: [clock], writes: [out], async run() {} })], /idle is async and run by the clock in a mind with no clock/)
        // Said plainly, a single run is fine.
        await expect(schedule([idle({ once: true, writes: [out] })]).schedule.run(TICK)).resolves.toBeUndefined()
    })

})

describe("Schedule: running", () => {
    it("runs each system in order, with the tick", async () => {
        const body = named<number>("body")
        const ran: string[] = []
        const { schedule: pipeline } = schedule([
            sys("read", { reads: [body], run: () => { ran.push("read") } }),
            sys("write", { writes: [body], run: tick => { ran.push(`write@${tick.now}`) } }),
        ])
        await pipeline.run(at(5))
        expect(ran).toEqual(["write@5", "read"])
    })

    it("runs a worker system on the main thread, in order, when there are no threads", async () => {
        const frame = named<number>("frame")
        const flow = named<number>("flow")
        const ran: string[] = []
        const { stage, schedule: inline } = schedule([
            sys("sense", { writes: [frame], run: () => { ran.push("sense"); stage.ecs.component.set("self", frame, 2) } }),
            sys("flow", { thread: "worker", reads: [frame], writes: [flow], run: () => { ran.push("flow"); stage.ecs.component.set("self", flow, stage.ecs.component.get("self", frame)! * 10) } }),
        ])
        await inline.run(TICK)
        expect(ran).toEqual(["sense", "flow"])
        expect(stage.ecs.component.get("self", flow)).toBe(20)
        expect(runs(stage).find(run => run.system === "flow").thread).toBeUndefined()
    })

    it("honours `once`, and runs a system only when what runs it has changed", async () => {
        const runs: Record<string, number> = { once: 0, reader: 0 }
        const a = named<number>("a")
        const fed = named<number>("fed")
        const b = named<number>("b")
        const { stage, schedule: timed } = schedule([
            sys("once", { once: true, writes: [a], run: () => { runs.once!++ } }),
            // Fed on the first and third ticks only.
            sys("feed", { writes: [fed], run: tick => { if (tick.now === 0 || tick.now === 100) stage.ecs.component.set("self", fed, tick.now) } }),
            sys("reader", { reads: [fed], writes: [b], run: () => { runs.reader!++ } }),
        ])
        for (const now of [0, 50, 100, 150, 200]) await timed.run(at(now))
        expect(runs).toEqual({ once: 1, reader: 2 })
    })

    it("runs a system named `on` a beat when the beat changes, not when what it reads does", async () => {
        const sight = named<number>("sight")
        const beat = named<number>("beat")
        const depth = named<number>("depth")
        const ran: number[] = []
        const { stage, schedule: paced } = schedule([
            // Sight changes every tick; the beat, every other.
            sys("eye", { writes: [sight], run: tick => stage.ecs.component.set("self", sight, tick.now) }),
            sys("rhythm", { writes: [beat], run: tick => { if (tick.now % 100 === 0) stage.ecs.component.set("self", beat, tick.now) } }),
            sys("depth", { on: [beat], reads: [sight], writes: [depth], run: () => { ran.push(stage.ecs.component.get("self", sight)!) } }),
        ])
        for (const now of [0, 50, 100, 150, 200]) await paced.run(at(now))
        // It ran on each beat, reading the sight of that very tick: the beat's writer ran first.
        expect(ran).toEqual([0, 100, 200])
        expect(paced.lineage.order().map(entry => entry.name)).toEqual(["eye", "rhythm", "depth"])
        expect(paced.lineage.declaration().systems.find(system => system.name === "depth")!.on).toEqual(["beat"])
    })

    it("runs a system `on` the clock every tick, though nothing it reads has changed", async () => {
        const quiet = named<number>("quiet")
        const fade = named<number>("fade")
        let runs = 0
        const { schedule: timed } = schedule([
            sys("still", { once: true, writes: [quiet] }),
            sys("fade", { on: [clock], reads: [quiet], writes: [fade], run: () => { runs++ } }),
        ])
        for (const now of [0, 50, 100]) await timed.run(at(now))
        expect(runs).toBe(3)
    })

    it("fails a run that reads what it did not declare", async () => {
        const secret = named<number>("secret")
        const out = named<number>("out")
        const { stage, schedule: sneaky } = schedule([
            sys("writer", { writes: [secret], run: () => stage.ecs.component.set("self", secret, 1) }),
            sys("sneaky", { writes: [out], run: () => { stage.ecs.component.get("self", secret) } }),
        ])
        await expect(sneaky.run(TICK)).rejects.toThrow(/sneaky read "secret" without declaring it/)
    })

    it("fails a run that writes what it did not declare", async () => {
        const out = named<number>("out")
        const { stage, schedule: sneaky } = schedule([sys("sneaky", { run: () => stage.ecs.component.set("self", out, 1) })])
        await expect(sneaky.run(TICK)).rejects.toThrow(/sneaky wrote "out" without declaring it/)
    })

    it("declares itself once, in run order, with every component's scope", async () => {
        const body = named<number>("sense/body", { display: { domain: "point", shape: "scalar" } })
        const { stage, schedule: pipeline } = schedule([
            sys("sense/read", { reads: [body] as Definition[] }),
            sys("sense/ingest", { writes: [body] as Component<any>[] }),
        ])
        await pipeline.run(TICK)
        await pipeline.run(TICK)

        const declarations = stage.of("cognet:schedule:declare")
        expect(declarations).toHaveLength(1)
        expect(declarations[0].hz).toBeNull()
        expect(declarations[0].systems.map((system: { name: string }) => system.name)).toEqual(["sense/ingest", "sense/read"])
        expect(declarations[0].components).toEqual([{ name: "sense/body", scope: "sense" }])
        expect(stage.of("cognet:component:declare")).toHaveLength(1)
    })

    it("emits what each run actually read", async () => {
        const body = named<number>("body")
        const { stage, schedule: pipeline } = schedule([
            sys("ingest", { writes: [body], run: () => stage.ecs.component.set("self", body, 1) }),
            sys("read", { reads: [body], run: () => { stage.ecs.component.get("self", body) } }),
        ])
        await pipeline.run(TICK)
        const reads = runs(stage).find(event => event.system === "read")
        expect(reads.reads).toEqual([{ entity: "self", component: "body", rev: 1 }])
    })

    it("carries matched and empty query observations into the run event", async () => {
        const body = named<number>("body")
        const { stage, schedule: pipeline } = schedule([
            sys("ingest", { writes: [body], run: () => stage.ecs.component.set("self", body, 1) }),
            sys("read", { reads: [body], run: () => {
                stage.ecs.query({ components: ["body"], where: { body: 1 } })
                stage.ecs.query({ components: ["body"], where: { body: 2 } })
            } }),
        ])
        await pipeline.run(TICK)
        const read = runs(stage).find(event => event.system === "read")
        expect(read.queries).toEqual([
            { ordinal: 0, required: ["body"], optional: [], where: { body: 1 }, filtered: false, candidates: 1, count: 1, matched: [{ entity: "self", values: [{ entity: "self", component: "body", rev: 1 }] }] },
            { ordinal: 1, required: ["body"], optional: [], where: { body: 2 }, filtered: false, candidates: 1, count: 0, matched: [] },
        ])
    })
})

describe("Schedule: overlapping ticks", () => {
    const slow: ScheduleTrace = { tick: fn => fn(() => {}), system: async (_name, fn) => { await new Promise(resolve => setTimeout(resolve, 1)); return fn(() => {}) } }

    it("runs one tick's systems to completion before the next tick's begin", async () => {
        const body = named<number>("body")
        const ran: string[] = []
        const stage = world()
        const pipeline = Schedule({
            ecs: stage.ecs,
            emit: stage.emit,
            trace: slow,
            systems: [
                sys("read", { reads: [body], run: tick => { ran.push(`read@${tick.now}`) } }),
                sys("write", { writes: [body], run: tick => { ran.push(`write@${tick.now}`); stage.ecs.component.set("self", body, tick.now) } }),
            ],
        })
        await Promise.all([pipeline.run(at(1)), pipeline.run(at(2))])
        expect(ran).toEqual(["write@1", "read@1", "write@2", "read@2"])
    })

    it("coalesces every wake that arrives mid-tick into one waiting tick, losing no stimulus", async () => {
        const seen: number[][] = []
        const stage = world()
        const pipeline = Schedule({
            ecs: stage.ecs,
            emit: stage.emit,
            trace: slow,
            systems: [sys("see", { reads: [stimuli], run: tick => { seen.push(labelled(tick.stimuli)) } })],
        })
        await Promise.all([
            pipeline.run(at(1, [stimulus(1)])),
            pipeline.run(at(2, [stimulus(2)])),
            pipeline.run(at(3, [stimulus(3)])),
        ])
        // Two ticks, not three: the backlog never exceeds one.
        expect(seen).toEqual([[1], [2, 3]])
    })

    it("opens one tick for the wakes that merged, numbered once, saying what it answered", async () => {
        const stage = world()
        const clock = Clock({ ticks: Ticks(), emit: stage.emit })
        const pipeline = Schedule({
            ecs: stage.ecs,
            emit: stage.emit,
            trace: { tick: (fn, opened) => clock.runTick(fn, opened), system: async (name, fn, ran) => { await new Promise(resolve => setTimeout(resolve, 1)); return clock.runSystem(name, fn, ran) } },
            systems: [sys("see", { reads: [stimuli] })],
        })
        await Promise.all([
            pipeline.run(at(1, [stimulus(1)])),
            pipeline.run(at(2, [stimulus(2)])),
            pipeline.run(at(3, [stimulus(3)])),
        ])
        expect(stage.of("cognet:tick:start")).toEqual([
            { tick: 1, now: 1, wakes: 1, admitted: { from: 0, count: 1 } },
            { tick: 2, now: 3, wakes: 2, admitted: { from: 1, count: 2 } },
        ])
        // Every run in a tick is stamped with that tick, however many wakes it answered.
        expect(runs(stage).map(run => run.tick)).toEqual([1, 2])
    })

    it("opens a tick that admitted nothing without saying it admitted anything", async () => {
        const stage = world()
        const clock = Clock({ ticks: Ticks(), emit: stage.emit })
        const pipeline = Schedule({ ecs: stage.ecs, emit: stage.emit, trace: { tick: (fn, opened) => clock.runTick(fn, opened), system: TRACE.system }, systems: [sys("tick")] })
        await pipeline.run(at(5))
        expect(stage.of("cognet:tick:start")).toEqual([{ tick: 1, now: 5, wakes: 1 }])
    })

    it("keeps running later ticks after one fails, and fails only that tick", async () => {
        const body = named<number>("body")
        let fail = true
        const stage = world()
        const pipeline = Schedule({
            ecs: stage.ecs, emit: stage.emit, trace: TRACE,
            systems: [sys("write", { writes: [body], run: () => { if (fail) { fail = false; throw new Error("once") } } })],
        })
        const first = pipeline.run(at(1))
        const second = pipeline.run(at(2))
        await expect(first).rejects.toThrow("once")
        await expect(second).resolves.toBeUndefined()
    })
})

describe("Schedule: a replay's landings", () => {
    const result = named<number>("result")
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    /** An async system that answers `ms` after it starts, and a reader of what it answers. */
    function minds(ms: number) {
        const seen: Array<number | undefined> = []
        let started = 0
        const { stage, schedule: mind } = schedule([
            sys("compute", { on: [clock], writes: [result], run: async () => { const mine = ++started; await delay(ms); ecs().component.set("self", result, mine) } }),
            sys("look", { on: [clock], recalls: [result], run: () => { seen.push(ecs().component.get("self", result)) } }),
        ], world(), 20)
        const ecs = () => stage.ecs
        return { mind: mind, seen: seen }
    }

    it("holds a settled run until the tick the replay names, not the next one", async () => {
        const { mind, seen } = minds(1)
        await mind.run({ ...at(1), lands: [] })
        await delay(10)
        // Settled long ago — live, it would land now.
        await mind.run({ ...at(2), lands: [] })
        await mind.run({ ...at(3), lands: ["compute"] })
        expect(seen).toEqual([undefined, undefined, 1])
    })

    it("waits for a run the replay says lands now, however long it is still running", async () => {
        const { mind, seen } = minds(30)
        await mind.run({ ...at(1), lands: [] })
        await mind.run({ ...at(2), lands: ["compute"] })
        expect(seen).toEqual([undefined, 1])
    })

    it("refuses a landing for a system with no run — the replay has diverged from the mind", async () => {
        const { mind } = minds(1)
        await expect(mind.run({ ...at(1), lands: ["compute"] })).rejects.toThrow(/has no run to land/)
    })
})

describe("Schedule: streams", () => {
    const reading = named<number>("reading")
    const beat = named<number>("beat")

    it("hands a system every value written since it last ran — a slow reader misses none, a repeat included", async () => {
        const local = world()
        const taken: number[][] = []
        let count = 0
        const values = [1, 2, 2, 3, 4]
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, values[count++]!) } }),
            // Paced by a beat every other tick — and it reads every reading between.
            sys("pace", { on: [clock], writes: [beat], run: () => { if (count % 2 === 1) local.ecs.component.set("self", beat, count) } }),
            sys("odometry", { on: [beat], streams: [reading], run: run => { taken.push(run.since(reading).map(one => one.value)) } }),
        ], local)
        for (let k = 0; k < 5; k++) await mind.run(at(k))
        // Beats at ticks 1, 3, 5: everything since the run before, the repeated 2 too.
        expect(taken).toEqual([[1], [2, 2], [3, 4]])
    })

    it("runs a system with no `on` when something it streams was written, even a value that changed nothing", async () => {
        const local = world()
        const runs: number[] = []
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, 7) } }),
            sys("count", { streams: [reading], run: run => { runs.push(run.since(reading).length) } }),
        ], local)
        for (let k = 0; k < 3; k++) await mind.run(at(k))
        expect(runs).toEqual([1, 1, 1])
    })

    it("refuses a stream it did not declare, at the call", async () => {
        const local = world()
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, 1) } }),
            sys("peek", { reads: [reading], run: run => { run.since(reading) } }),
        ], local)
        await expect(mind.run(TICK)).rejects.toThrow(/peek asked for every write to "reading" without declaring it in streams/)
    })

    it("orders a stream like a read, and refuses one nothing writes", async () => {
        const { schedule: built } = schedule([
            sys("b/odometry", { streams: [reading] }),
            sys("a/ear", { writes: [reading] }),
        ])
        expect(names(built.lineage.order())).toEqual(["a/ear", "b/odometry"])
        await expect(schedule([sys("orphan", { streams: [reading] })]).schedule.run(TICK)).rejects.toThrow(/orphan streams "reading", which no system writes/)
    })

    it("lets go of what every reader has taken", async () => {
        const local = world()
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, 1) } }),
            sys("take", { streams: [reading] }),
        ], local)
        for (let k = 0; k < 4; k++) await mind.run(at(k))
        // Taken as soon as written: nothing is held past the tick.
        expect(local.ecs.state.history.since("reading", 0)).toEqual([])
    })
})

describe("Schedule: lag", () => {
    const total = named<number>("total")
    const reading = named<number>("reading")

    it("lands a lagged system's writes exactly its lag later, before any system runs that tick", async () => {
        const local = world()
        const seen: Array<number | undefined> = []
        let count = 0
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, ++count) } }),
            sys("sum", { lag: 2, streams: [reading], recalls: [total], writes: [total], run: run => {
                local.ecs.component.set("self", total, (local.ecs.component.get("self", total) ?? 0) + run.since(reading).reduce((sum, one) => sum + one.value, 0))
            } }),
            sys("look", { on: [clock], recalls: [total], run: () => { seen.push(local.ecs.component.get("self", total)) } }),
        ], local, 20)
        for (let k = 0; k < 6; k++) await mind.run(at(k))
        // Started at 1, lands at 3 (1); started at 3, lands at 5 (1 + 2 + 3).
        expect(seen).toEqual([undefined, undefined, 1, 1, 6, 6])
        expect(runs(local).filter(run => run.system === "sum").map(run => run.lag)).toEqual([2, 2])
    })

    it("adds no ordering edge for what it writes — its readers need not wait, and no cycle forms through it", async () => {
        const pose = named<number>("pose")
        const { schedule: built } = schedule([
            sys("odometry", { lag: 1, reads: [reading], writes: [pose] }),
            sys("ear", { reads: [pose], writes: [reading] }),
        ], world(), 20)
        built.lineage.check()
        expect(names(built.lineage.order())).toEqual(["ear", "odometry"])
        expect(built.lineage.waits().get("odometry")).toEqual(["ear"])
    })

    it("fails the tick it lands in when it threw, not the tick it ran in", async () => {
        const local = world()
        const { schedule: mind } = schedule([
            sys("ear", { on: [clock], writes: [reading], run: () => { local.ecs.component.set("self", reading, 1) } }),
            sys("bad", { lag: 1, reads: [reading], writes: [total], run: () => { throw new Error("lagged and broken") } }),
        ], local, 20)
        await expect(mind.run(at(1))).resolves.toBeUndefined()
        await expect(mind.run(at(2))).rejects.toThrow("lagged and broken")
    })

    it("refuses a lag that is no whole number of ticks, on an async system, or in a mind with no clock", async () => {
        const go = (systems: NamedSystem[], hz?: number) => schedule(systems, world(), hz).schedule.run(TICK)
        await expect(go([sys("odd", { lag: 1.5, writes: [total] })], 20)).rejects.toThrow(/odd has `lag: 1.5` — a lag is a whole number of ticks/)
        await expect(go([sys("both", { lag: 2, writes: [total], run: async () => {} })], 20)).rejects.toThrow(/both is `async` and has `lag: 2`/)
        await expect(go([sys("clockless", { lag: 1, writes: [total] })])).rejects.toThrow(/clockless has `lag: 1` in a mind with no clock/)
    })
})

describe("Schedule: stimuli", () => {
    it("gives each reader everything since IT last ran — a slow reader misses nothing", async () => {
        const fast: number[][] = []
        const slow: number[][] = []
        const out = named<number>("out")
        const beat = named<number>("beat")
        const { stage, schedule: senses } = schedule([
            sys("fast", { reads: [stimuli], run: tick => { fast.push(labelled(tick.stimuli)) } }),
            // Paced by a beat on the first and third ticks: it takes what arrived between.
            sys("rhythm", { writes: [beat], run: tick => { if (tick.now !== 50) stage.ecs.component.set("self", beat, tick.now) } }),
            sys("slow", { on: [beat], reads: [stimuli], writes: [out], run: tick => { slow.push(labelled(tick.stimuli)) } }),
        ])
        await senses.run(at(0, [stimulus(1)]))
        await senses.run(at(50, [stimulus(2)]))
        await senses.run(at(100, [stimulus(3)]))

        expect(fast).toEqual([[1], [2], [3]])
        expect(slow).toEqual([[1], [2, 3]])
    })

    it("refuses stimuli to a system that did not declare them", async () => {
        const { schedule: sneaky } = schedule([sys("sneaky", { run: tick => { void tick.stimuli } })])
        await expect(sneaky.run(at(0, [stimulus(1)]))).rejects.toThrow(/sneaky read stimuli without declaring/)
    })

    it("records which stimuli each run consumed, so provenance reaches past ingestion", async () => {
        const out = named<number>("out")
        const { stage, schedule: senses } = schedule([sys("see", { reads: [stimuli], writes: [out] })])
        await senses.run(at(0, [stimulus(1), stimulus(2)]))
        expect(runs(stage)[0].inputs).toEqual([{ seq: 101, channel: "/body" }, { seq: 102, channel: "/body" }])
    })

    it("declares stimuli as a read in the lineage", async () => {
        const { stage, schedule: senses } = schedule([sys("see", { reads: [stimuli] })])
        await senses.run(TICK)
        expect(stage.of("cognet:schedule:declare")[0].systems[0].reads).toEqual(["stimuli"])
    })
})

describe("Schedule: async systems", () => {
    /** These run beside a continuous mind's ticks: a mind with no clock may not restart an async system every tick. */
    function continuous(systems: NamedSystem[], stage = world()) {
        return schedule(systems, stage, 20)
    }

    /** Resolve-by-hand: an async run blocks here until the test lets it go. */
    function gate() {
        let open!: () => void
        const shut = new Promise<void>(resolve => { open = resolve })
        return { open: open, shut: shut }
    }

    const flush = () => new Promise(resolve => setTimeout(resolve, 0))

    it("says what it is working on beside the ticks: when a run starts, and when the last one settles", async () => {
        const answer = named<number>("answer")
        const slow = gate()
        const stage = world()
        const { schedule: mind } = continuous([
            sys("think", { writes: [answer], async run() { await slow.shut; stage.ecs.component.set("self", answer, 42) } }),
        ], stage)

        await mind.run(at(0))
        expect(stage.of("cognet:activity").map(one => one.working)).toEqual([["think"]])

        slow.open()
        await flush()
        expect(stage.of("cognet:activity").map(one => one.working)).toEqual([["think"], []])
    })

    it("settles a stimulus only once every reader is done with it — an async reader when its run lands", async () => {
        const slow = gate()
        const stage = world()
        const { schedule: mind } = continuous([
            sys("glance", { reads: [stimuli], run: () => {} }),
            sys("think", { reads: [stimuli], async run() { await slow.shut } }),
        ], stage)
        const settled = () => stage.of("cognet:settled").flatMap(one => one.seqs)

        await mind.run(at(0, [stimulus(1)]))
        // glance is done with it; think is still thinking.
        expect(settled()).toEqual([])

        slow.open()
        await flush()
        await mind.run(at(1))
        expect(settled()).toEqual([101])
    })

    it("settles what no system reads on arrival — nothing will ever take it", async () => {
        const stage = world()
        const { schedule: mind } = continuous([sys("tick", { on: [clock], run: () => {} })], stage)
        await mind.run(at(0, [stimulus(2)]))
        expect(stage.of("cognet:settled").flatMap(one => one.seqs)).toEqual([102])
    })

    it("does not hold the tick, and lands its writes at the start of the next one", async () => {
        const answer = named<number>("answer")
        const seen: Array<number | undefined> = []
        const slow = gate()
        const stage = world()
        const { schedule: mind } = continuous([
            sys("think", { writes: [answer], async run() { await slow.shut; stage.ecs.component.set("self", answer, 42) } }),
            sys("read", { reads: [answer], run: () => { seen.push(stage.ecs.component.get("self", answer)) } }),
        ], stage)

        await mind.run(at(0))
        expect(seen).toEqual([undefined])
        expect(stage.ecs.component.get("self", answer)).toBeUndefined()

        slow.open()
        await flush()
        // Settled, but not landed: no tick boundary has passed.
        expect(stage.ecs.component.get("self", answer)).toBeUndefined()

        await mind.run(at(1))
        expect(seen).toEqual([undefined, 42])
    })

    it("a wake waits for the runs it started, not for another wake's", async () => {
        const out = named<number>("out")
        const slow = gate()
        const { schedule: mind } = continuous([sys("think", { writes: [out], async run() { await slow.shut } })])
        const first = new AbortController().signal
        const second = new AbortController().signal

        await mind.run(at(0, [], first))
        await mind.run(at(1, [], second))
        // The run belongs to the wake that started it: the second has nothing to hold open for.
        expect(mind.busy(first)).toBe(true)
        expect(mind.busy(second)).toBe(false)
        await mind.settled(second)

        slow.open()
        await mind.settled(first)
        expect(mind.busy(first)).toBe(true)
    })

    it("is not started again while a run is in flight", async () => {
        const out = named<number>("out")
        let starts = 0
        const slow = gate()
        const { schedule: mind } = continuous([sys("think", { writes: [out], async run() { starts++; await slow.shut } })])

        await mind.run(at(0))
        await mind.run(at(1))
        await mind.run(at(2))
        expect(starts).toBe(1)

        slow.open()
        await mind.settled(SIGNAL)
        await mind.run(at(3))
        expect(starts).toBe(2)
    })

    it("reads a snapshot taken when it started, and its own writes", async () => {
        const body = named<number>("body")
        const echo = named<number>("echo")
        const slow = gate()
        let saw: Array<number | undefined> = []
        const stage = world()
        const { schedule: mind } = continuous([
            sys("ingest", { writes: [body], run: tick => stage.ecs.component.set("self", body, tick.now) }),
            sys("think", {
                reads: [body],
                writes: [echo],
                async run() {
                    await slow.shut
                    stage.ecs.component.set("self", echo, 7)
                    saw = [stage.ecs.component.get("self", body), stage.ecs.component.get("self", echo)]
                },
            }),
        ], stage)

        await mind.run(at(1))
        await mind.run(at(2))
        slow.open()
        await mind.settled(SIGNAL)

        // body is 2 in the live world, but the run began when it was 1.
        expect(stage.ecs.component.get("self", body)).toBe(2)
        expect(saw).toEqual([1, 7])
    })

    it("refuses an undeclared access at the moment it happens", async () => {
        const secret = named<number>("secret")
        const out = named<number>("out")
        const stage = world()
        const { schedule: mind } = continuous([
            sys("writer", { writes: [secret], run: () => stage.ecs.component.set("self", secret, 1) }),
            sys("sneaky", { writes: [out], async run() { stage.ecs.component.get("self", secret) } }),
        ], stage)

        await mind.run(at(0))
        await mind.settled(SIGNAL)
        await expect(mind.run(at(1))).rejects.toThrow(/sneaky read "secret" without declaring it/)
    })

    it("fails the tick it would have landed in — and still lands the others", async () => {
        const good = named<number>("good")
        const bad = named<number>("bad")
        const stage = world()
        const { schedule: mind } = continuous([
            sys("fine", { writes: [good], async run() { stage.ecs.component.set("self", good, 1) } }),
            sys("broken", { writes: [bad], async run() { throw new Error("model fell over") } }),
        ], stage)

        await mind.run(at(0))
        await mind.settled(SIGNAL)
        await expect(mind.run(at(1))).rejects.toThrow("model fell over")
        expect(stage.ecs.component.get("self", good)).toBe(1)
    })

    it("drops a run its wake cancelled, reporting it interrupted", async () => {
        const out = named<number>("out")
        const cancel = new AbortController()
        const stage = world()
        const { schedule: mind } = continuous([
            sys("think", {
                writes: [out],
                async run(run) {
                    await new Promise((_, reject) => run.signal.addEventListener("abort", () => reject(new Error("aborted"))))
                    stage.ecs.component.set("self", out, 1)
                },
            }),
        ], stage)

        await mind.run(at(0, [], cancel.signal))
        cancel.abort()
        await mind.settled(cancel.signal)
        await expect(mind.run(at(1))).resolves.toBeUndefined()
        expect(stage.ecs.component.get("self", out)).toBeUndefined()
        expect(runs(stage).filter(event => event.outcome === "interrupted").map(event => event.system)).toEqual(["think"])
    })

    it("adds no ordering edge — its writes land before every system of a later tick", () => {
        const answer = named<number>("answer")
        const order = continuous([
            sys("a-read", { reads: [answer] }),
            sys("z-think", { writes: [answer], async run() {} }),
        ]).schedule.lineage.order()
        expect(names(order)).toEqual(["a-read", "z-think"])
    })
})

describe("Schedule: what runs a system", () => {
    it("never runs a system in reaction to its own writes, nor to what it recalls", async () => {
        const step = named<number>("step")
        const pose = named<number>("pose")
        const ran: string[] = []
        const stage = world()
        const { schedule: mind } = schedule([
            sys("step", { once: true, writes: [step], run: () => { ran.push("step"); stage.ecs.component.set("self", step, 1) } }),
            // Recalls and rewrites its own output, the way odometry does.
            sys("odometry", { reads: [step], recalls: [pose], writes: [pose], run: () => {
                ran.push("odometry")
                stage.ecs.component.set("self", pose, (stage.ecs.component.get("self", pose) ?? 0) + 1)
            } }),
        ], stage)

        await mind.run(at(0))
        expect(ran).toEqual(["step", "odometry"])
        ran.length = 0
        await mind.run(at(1))
        await mind.run(at(2))
        expect(ran).toEqual([])
    })
})
