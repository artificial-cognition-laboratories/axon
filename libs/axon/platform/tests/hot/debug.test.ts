import { describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Encoder } from "@arcforge/session"
import { Debug } from "../../src/debug"

/**
 * `axon debug` against a session written the way a real one is: a JSON-lines
 * log, and telemetry segments in the ring's own binary format.
 */

const ID = "aaaaaaaa-0000-4000-8000-000000000001"

const DECLARED = {
    hz: 20,
    systems: [
        { name: "L0/eye/see", on: null, once: false, async: false, worker: false, reads: [], recalls: [], writes: ["L0/sight"] },
        { name: "L0/map/place", on: null, once: false, async: false, worker: true, reads: ["L0/sight"], recalls: ["L0/pace"], writes: ["L0/pose", "L0/trouble"] },
        { name: "L0/attention/pace", on: null, once: false, async: true, worker: false, reads: ["L0/pose"], recalls: [], writes: ["L0/pace"] },
    ],
    components: ["L0/sight", "L0/pose", "L0/pace", "L0/trouble"].map(name => ({ name: name, scope: "L0", public: true, open: false, probe: false, resident: false })),
    queries: [],
}

type Line = { type: string; time: { ms: number; seq: number }; data: unknown; context?: { spanId: string } }

function segment(events: Line[]): Uint8Array {
    const encoder = Encoder()
    encoder.begin()
    for (const event of events) encoder.encode(event)
    return encoder.take()
}

/** An agent directory holding one session: `log` lines and telemetry `segments`. */
function agent(log: Line[], segments: Line[][], id = ID): string {
    const root = mkdtempSync(join(tmpdir(), "axon-debug-"))
    const data = join(root, ".agent", "data")
    mkdirSync(join(data, "sessions"), { recursive: true })
    const header = { type: "session:header", version: 2, agentId: "@test/mind", sessionId: id, startedAt: "2026-10-02T06:00:00.000Z" }
    writeFileSync(join(data, "sessions", `${id}.jsonl`), [header, ...log].map(line => JSON.stringify(line)).join("\n") + "\n")
    if (segments.length) mkdirSync(join(data, "telemetry", id), { recursive: true })
    segments.forEach((events, index) => writeFileSync(join(data, "telemetry", id, `${String(index).padStart(6, "0")}.axt`), segment(events)))
    return root
}

let seq = 0
const at = (ms: number) => ({ ms: 1_000_000 + ms, seq: seq++ })
const run = (ms: number, tick: number, system: string, durationMs: number, more: object = {}): Line =>
    ({ type: "cognet:system:run", time: at(ms), data: { tick: tick, phase: null, system: system, at: 1_000_000 + ms, durationMs: durationMs, outcome: "complete", ...more } })
const tick = (ms: number, number: number, durationMs: number, held?: Array<{ system: string; ms: number }>): Line => ({ type: "cognet:tick:complete", time: at(ms), data: { tick: number, durationMs: durationMs, ...(held ? { held: held } : {}) } })

const LOG: Line[] = [
    { type: "build:start", time: at(0), data: {} },
    { type: "cognet:schedule:declare", time: at(1), data: DECLARED },
    { type: "axon:log:error", time: at(2), data: { message: "frame missing" } },
]

const RING: Line[][] = [
    [
        run(100, 1, "L0/eye/see", 4),
        run(101, 1, "L0/map/place", 30, { thread: 0 }),
        run(102, 1, "L0/attention/pace", 900, { async: true }),
        { type: "cognet:component:add", time: at(103), data: { tick: 1, phase: null, system: "L0/map/place", entity: "trouble:misplaced", component: "L0/trouble", rev: 1, value: { what: "misplaced", detail: "half the view disagreed" } } },
        // The tick waited 30ms for the worker running place.
        tick(104, 1, 950, [{ system: "L0/map/place", ms: 30 }]),
    ],
    [
        run(200, 2, "L0/eye/see", 70),
        run(201, 2, "L0/map/place", 2, { thread: 0, outcome: "failed", error: { code: "AX-X-1", message: "no fit" } }),
        { type: "cognet:component:update", time: at(202), data: { tick: 2, phase: null, system: "L0/map/place", entity: "camera", component: "L0/pose", rev: 2, value: { at: [1, 2, 3], samples: Array.from({ length: 40 }, (_, index) => index) } } },
        { type: "cognet:component:remove", time: at(203), data: { tick: 2, phase: null, system: "L0/map/place", entity: "trouble:misplaced", component: "L0/trouble" } },
        tick(204, 2, 80),
    ],
]

describe("debug — finding sessions", () => {
    it("lists sessions newest first with what each holds, and resolves one by prefix or `latest`", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        const found = await debug.sessions(root, 10)
        expect(found.total).toBe(1)
        expect(found.sessions[0]).toMatchObject({ id: ID, startedAt: "2026-10-02T06:00:00.000Z" })
        expect(found.sessions[0]!.bytes.telemetry).toBeGreaterThan(0)
        expect((await debug.session(root, "aaaa")).id).toBe(ID)
        expect((await debug.session(root, "latest")).id).toBe(ID)
        await expect(debug.session(root, "zzzz")).rejects.toThrow(/zzzz/)
    })

    it("sums a session up: its mind, its ticks, what went wrong, what cost most", async () => {
        const one = await Debug().session(agent(LOG, RING), "latest")
        expect(one.mind).toEqual({ systems: 3, components: 4, targetPerSecond: 20 })
        // One error in the log, one failed run in the ring.
        expect(one.faults.total).toBe(2)
        expect(one.faults.first).toMatchObject({ type: "axon:log:error", message: "frame missing" })
        expect(one.troubles).toEqual({ opened: 1 })
        expect(one.costliest[0]!.system).toBe("L0/attention/pace")
    })
})

describe("debug — timings", () => {
    it("holds the deadline to main-thread time, not to async or worker time", async () => {
        const perf = await Debug().perf(agent(LOG, RING), "latest")
        // Tick 1 held the main thread 4ms; tick 2, 70ms — over the 50ms a 20Hz mind has.
        expect(perf.ticks.main).toMatchObject({ runs: 2, maxMs: 70 })
        expect(perf.ticks.overTarget).toBe(1)
        expect(perf.ticks.wall.maxMs).toBe(950)
        const pace = perf.systems.find(system => system.system === "L0/attention/pace")!
        expect(pace).toMatchObject({ runs: 1, async: true, maxMs: 900 })
        expect(perf.systems.find(system => system.system === "L0/map/place")).toMatchObject({ runs: 2, failed: 1, threads: [0] })
    })

    it("counts ticks late by the clock, and says what each waited on — what a deadline held to the main thread never sees", async () => {
        const root = agent(LOG, RING)
        const perf = await Debug().perf(root, "latest")
        // Both ran past 50ms start to end; only tick 2 held the main thread past it.
        expect(perf.ticks.late).toBe(2)
        expect(perf.held).toEqual([{ system: "L0/map/place", ticks: 1, totalMs: 30, meanMs: 30, maxMs: 30 }])
        expect(perf.systems.find(system => system.system === "L0/map/place")).toMatchObject({ heldMs: 30, heldTicks: 1 })
        const signs = (await Debug().session(root, "latest")).signs
        expect(signs.found.find(sign => sign.sign === "late")?.detail).toBe("2 of 2 ticks ran past 50ms, the worst 950ms; held by L0/map/place for 30ms over 1 tick (the worst 30ms)")
    })

    it("narrows to one system by the end of its name", async () => {
        const perf = await Debug().perf(agent(LOG, RING), "latest", "see")
        expect(perf.systems.map(system => system.system)).toEqual(["L0/eye/see"])
    })
})

describe("debug — the graph", () => {
    it("walks what a system reaches, marking the edges that cross a tick", async () => {
        const root = agent(LOG, RING)
        const found = await Debug().graph.system(root, "latest", "see", { direction: "downstream", depth: 5 })
        expect(found.system.name).toBe("L0/eye/see")
        expect(found.downstream).toEqual([
            { system: "L0/map/place", through: "L0/sight", edge: "reads", depth: 1 },
            { system: "L0/attention/pace", through: "L0/pose", edge: "reads", depth: 2 },
        ])
        const back = await Debug().graph.system(root, "latest", "L0/map/place", { direction: "upstream", depth: 1 })
        expect(back.upstream).toEqual([
            { system: "L0/eye/see", through: "L0/sight", edge: "reads", depth: 1 },
            { system: "L0/attention/pace", through: "L0/pace", edge: "recalls", depth: 1 },
        ])
    })

    it("says who writes and reads a component, and refuses a name it does not know", async () => {
        const root = agent(LOG, RING)
        expect((await Debug().graph.component(root, "latest", "pace")).component).toMatchObject({ name: "L0/pace", writtenBy: ["L0/attention/pace"], readBy: [], recalledBy: ["L0/map/place"] })
        await expect(Debug().graph.component(root, "latest", "nothing")).rejects.toThrow(/nothing/)
    })

    it("refuses a session in which no mind declared itself", async () => {
        await expect(Debug().graph.all(agent([LOG[0]!], []), "latest")).rejects.toThrow(/declared no schedule/)
    })
})

describe("debug — events", () => {
    const all = { limit: 50, tail: false, full: false }

    it("gives log and ring events in one order, and filters by type, system and tick", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        const every = await debug.events(root, "latest", all)
        expect(every.events.map(event => event.time.seq)).toEqual([...every.events.map(event => event.time.seq)].sort((a, b) => a - b))
        expect(every.events).toHaveLength(LOG.length + RING.flat().length)

        const runs = await debug.events(root, "latest", { ...all, type: "cognet:system:run", system: "place" })
        expect(runs.events.map(event => (event.data as { tick: number }).tick)).toEqual([1, 2])
        const second = await debug.events(root, "latest", { ...all, fromTick: 2 })
        expect(second.events.every(event => (event.data as { tick: number }).tick === 2)).toBe(true)
    })

    it("stops at the limit and says where to carry on from; a tail gives the last instead", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        const first = await debug.events(root, "latest", { ...all, type: "cognet:system:run", limit: 2 })
        expect(first.events).toHaveLength(2)
        expect(first.next).toBe(first.events[1]!.time.seq)
        const rest = await debug.events(root, "latest", { ...all, type: "cognet:system:run", after: first.next! })
        expect(rest.events).toHaveLength(3)
        expect(rest.next).toBeNull()

        const last = await debug.events(root, "latest", { ...all, type: "cognet:system:run", limit: 2, tail: true })
        expect(last.events.map(event => (event.data as { system: string }).system)).toEqual(["L0/eye/see", "L0/map/place"])
        expect((last.events[0]!.data as { tick: number }).tick).toBe(2)
    })

    it("cuts a long value and says how long it was, unless asked for in full", async () => {
        const root = agent(LOG, RING)
        const cut = await Debug().events(root, "latest", { ...all, component: "pose" })
        expect((cut.events[0]!.data as any).value.samples).toEqual({ cut: "40 numbers", first: [0, 1, 2, 3] })
        const whole = await Debug().events(root, "latest", { ...all, component: "pose", full: true })
        expect((whole.events[0]!.data as any).value.samples).toHaveLength(40)
    })
})

/** A usage sample `seconds` in: the brain holding `ram` MB, its main thread and one worker busy — on a machine `busy` percent in use, by `others`. */
const usage = (seconds: number, ram: number, busy = 10, others: Array<{ pid: number; name: string; cpu: number }> = []): Line => ({
    type: "axon:usage",
    time: at(seconds * 1000),
    data: {
        at: 1_000_000 + seconds * 1000,
        parts: { brain: { cpu: 1.5, ram: ram * 1024 * 1024, gpu: null, vram: null, processes: 1, shared: false } },
        threads: [
            { pid: 10, tid: 10, name: "bun", cpu: 0.4 },
            { pid: 10, tid: 77, name: "Worker", cpu: 0.9 },
            { pid: 10, tid: 20, name: "Bun Pool 0", cpu: 0.1 },
            { pid: 10, tid: 21, name: "Bun Pool 1", cpu: 0.1 },
        ],
        machine: { cores: 8, cpu: busy, ram: { used: 1, total: 16 * 1024 * 1024 * 1024 }, gpu: null, vram: { used: null, total: null }, busiest: others },
    },
})

describe("debug — resources", () => {
    const started: Line = { type: "cognet:thread:start", time: at(5), data: { index: 0, pid: 10, tid: 77 } }
    /** Five minutes of samples, ten seconds apart: 200MB at boot, then rising `rate` MB a minute. */
    const growing = (rate: number): Line[] => Array.from({ length: 31 }, (_, index) => usage(index * 10, 200 + (index * 10 / 60) * rate))

    it("gives each part's memory and how fast it is rising, after start-up", async () => {
        const found = await Debug().resources(agent([...LOG, started, ...growing(30)], RING), "latest", 4)
        expect(found.window).toMatchObject({ samples: 31, seconds: 300 })
        expect(found.machine).toEqual({ cores: 8, ramMb: 16384, cpuPercent: { mean: 10, max: 10 }, busiest: [] })
        expect(found.parts.brain!.ramMb).toMatchObject({ first: 200, last: 350, peak: 350, perMinute: 30, perMinuteLately: 30 })
        expect(found.parts.brain!.ramMb!.series).toEqual([200, 250, 300, 350])
        expect(found.parts.brain!.cpuCores).toEqual({ mean: 1.5, max: 1.5 })
        expect(found.parts.brain!.gpuPercent).toBeNull()
    })

    it("says nothing of growth lately over too short a stretch to tell it from the collector's sawtooth", async () => {
        // A 109s session (measured 2026-10-09): past start-up, a collector's swings read as 40MB a minute.
        const short = Array.from({ length: 12 }, (_, index) => usage(index * 10, 800 + (index % 2) * 100))
        const found = await Debug().resources(agent([...LOG, started, ...short], RING), "latest", 4)
        expect(found.parts.brain!.ramMb!.perMinuteLately).toBeNull()
    })

    it("names the main thread and each worker, and groups the runtime's own", async () => {
        const found = await Debug().resources(agent([...LOG, started, ...growing(0)], RING), "latest", 4)
        expect(found.threads).toEqual([
            { thread: "worker 0", threads: 1, meanCores: 0.9, maxCores: 0.9 },
            { thread: "main", threads: 1, meanCores: 0.4, maxCores: 0.4 },
            { thread: "Bun Pool", threads: 2, meanCores: 0.2, maxCores: 0.2 },
        ])
    })
})

describe("debug — signs", () => {
    it("says what is not well in one line each, and which checks it made", async () => {
        const rising = Array.from({ length: 31 }, (_, index) => usage(index * 10, 200 + index * 5))
        const one = await Debug().session(agent([...LOG, ...rising], RING), "latest")
        expect(one.signs.checked).toEqual(["faults", "failing", "slow", "deadline", "late", "memory", "saturated", "inference", "troubles", "quiet"])
        expect(one.signs.found.map(sign => sign.sign)).toEqual(["faults", "failing", "deadline", "late", "memory"])
        expect(one.signs.found.find(sign => sign.sign === "memory")!.detail).toBe("brain is still growing, 30MB a minute: 200MB at first, 350MB now, 350MB at most")
        expect(one.signs.found.find(sign => sign.sign === "failing")!.detail).toBe("L0/map/place failed 1 of 2 runs")
    })

    it("finds nothing in a session that ran well — memory that rose and levelled off is not growing", async () => {
        const steady = Array.from({ length: 31 }, (_, index) => usage(index * 10, Math.min(600, 200 + index * 40)))
        // Twenty ticks in a second, each a millisecond on the main thread.
        const well = Array.from({ length: 21 }, (_, index) => [run(index * 50, index, "L0/eye/see", 1), tick(index * 50 + 1, index, 1)]).flat()
        const one = await Debug().session(agent([LOG[0]!, LOG[1]!, ...steady], [well]), "latest")
        expect(one.signs.found).toEqual([])
    })

    /**
     * A body was put out of its world 107s into a twelve-minute session: its
     * vectors stopped, the mind ticked on over nothing, and no sign said so.
     */
    it("says which senses fell silent while the mind ran on", async () => {
        const vector = (ms: number, channel: string): Line => ({ type: "cognet:stimulus:vector", time: at(ms), data: { channel: channel, values: [0], labels: ["x"], units: ["u"] } })
        // `/body` at 20/s for 30s, then nothing; `/input` the whole minute; `/session` only twice — too rare to judge.
        const body = Array.from({ length: 600 }, (_, index) => vector(index * 50, "/body"))
        const input = Array.from({ length: 1200 }, (_, index) => vector(index * 50, "/input"))
        const session = [vector(0, "/session"), vector(30_000, "/session")]
        const well = Array.from({ length: 21 }, (_, index) => [run(index * 50, index, "L0/eye/see", 1), tick(index * 50 + 1, index, 1)]).flat()
        const one = await Debug().session(agent([LOG[0]!, LOG[1]!, ...[...body, ...input, ...session].sort((a, b) => a.time.ms - b.time.ms)], [well]), "latest")
        expect(one.signs.found).toEqual([{ sign: "quiet", detail: "/body fell silent 30s before the end, after 600 arrivals at 20/s" }])
    })

    it("says when the machine was full, what of that was the agent's, and whose the rest was", async () => {
        // Two browser processes are one browser; a compiler busy for half the session reads as half.
        const full = Array.from({ length: 31 }, (_, index) => usage(index * 10, 300, 97, [
            { pid: 50, name: "browser", cpu: 2 }, { pid: 51, name: "browser", cpu: 1 },
            ...(index % 2 === 0 ? [{ pid: 60, name: "cc", cpu: 2 }] : []),
        ]))
        const well = Array.from({ length: 21 }, (_, index) => [run(index * 50, index, "L0/eye/see", 1), tick(index * 50 + 1, index, 1)]).flat()
        const root = agent([LOG[0]!, LOG[1]!, ...full], [well])
        const one = await Debug().session(root, "latest")
        expect(one.signs.found).toEqual([{ sign: "saturated", detail: "the machine was 97% busy across 8 cores; this agent's parts, in cores: brain 1.5; the busiest processes on the machine: browser 3, cc 1.03" }])
        const found = await Debug().resources(root, "latest", 4)
        expect(found.machine!.busiest).toEqual([
            { process: "browser", processes: 2, meanCores: 3, maxCores: 3 },
            { process: "cc", processes: 1, meanCores: 1.03, maxCores: 2 },
        ])
    })
})

describe("debug — the index", () => {
    it("reads only what was added since it was last asked", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        expect((await debug.errors(root, "latest")).faultsTotal).toBe(2)
        appendFileSync(join(root, ".agent", "data", "sessions", `${ID}.jsonl`), JSON.stringify({ type: "kernel:run:failed", time: at(900), data: {} }) + "\n{\"type\":\"torn")
        const again = await debug.errors(root, "latest")
        expect(again.faultsTotal).toBe(3)
        // The line still being written is not an event, and not an error either.
        expect((await debug.session(root, "latest")).log.torn).toBe(0)
    })
})

describe("debug — prune", () => {
    /** Every part of a session last written `days` ago. */
    function age(path: string, days: number): void {
        const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        if (!existsSync(path)) return
        if (statSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), days)
        utimesSync(path, then, then)
    }

    it("says what the retention rule would remove, and removes it — the whole session — only when applied", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        const data = join(root, ".agent", "data")
        age(data, 4)

        const dry = await debug.prune(root, { apply: false }, Date.now())
        expect(dry.removed.map(entry => [entry.id, entry.why])).toEqual([[ID, "age"]])
        expect(existsSync(join(data, "telemetry", ID))).toBe(true)

        await debug.prune(root, { apply: true }, Date.now())
        expect(existsSync(join(data, "telemetry", ID))).toBe(false)
        expect(existsSync(join(data, "sessions", `${ID}.jsonl`))).toBe(false)
    })

    it("leaves a session that was just written to, and keeps one younger than the rule", async () => {
        const root = agent(LOG, RING)
        const debug = Debug()
        expect((await debug.prune(root, { days: 0, apply: true }, Date.now())).removed).toEqual([])
        age(join(root, ".agent", "data"), 1)
        expect((await debug.prune(root, { apply: false }, Date.now())).removed).toEqual([])
        expect((await debug.prune(root, { days: 0, apply: false }, Date.now())).removed.map(entry => entry.id)).toEqual([ID])
    })
})

describe("debug — inference", () => {
    /** One call to a model: asked at `from`, answered `took` ms later. */
    const call = (span: string, role: string, from: number, took: number, how = "complete"): Line[] => [
        { type: "kernel:transform:start", time: at(from), context: { spanId: span }, data: { role: role, provider: "supervisor" } },
        { type: `kernel:transform:${how}`, time: at(from + took), context: { spanId: span }, data: { role: role, durationMs: took } },
    ]
    const ordered = (lines: Line[]): Line[] => lines.sort((a, b) => a.time.ms - b.time.ms)

    it("says how often each role was called, how long it took, and how many calls were already under way", async () => {
        // Over ten seconds: depth alone, then features and segment asked while depth is still out.
        const lines = ordered([
            ...call("a", "depth", 0, 100),
            ...call("b", "depth", 1000, 400),
            ...call("c", "features", 1100, 800),
            ...call("d", "segment", 1200, 500, "failed"),
            ...call("e", "depth", 9900, 100),
        ])
        const found = await Debug().inference(agent([...LOG, ...lines], RING), "latest")
        expect(found.window.seconds).toBe(10)
        expect(found.calls).toBe(5)
        expect(found.behind).toEqual([{ already: 0, calls: 3 }, { already: 1, calls: 1 }, { already: 2, calls: 1 }])
        expect(found.roles.map(role => role.role)).toEqual(["features", "depth", "segment"])
        expect(found.roles[1]).toMatchObject({ role: "depth", calls: 3, failed: 0, perSecond: 0.3, meanMs: 200, maxMs: 400, busy: 0.06 })
        expect(found.roles[2]).toMatchObject({ role: "segment", calls: 1, failed: 1 })
        expect(found.busy).toBe(0.19)
        expect(found.unanswered).toBe(0)
    })

    it("raises a sign when calls add up to more than a worker has", async () => {
        // Three roles, each asking again the moment it is answered, each answer 900ms late.
        const lines = ordered(["features", "depth", "segment"].flatMap((role, lane) => Array.from({ length: 10 }, (_, turn) => call(`${role}${turn}`, role, lane * 10 + turn * 1000, 900)).flat()))
        const well = Array.from({ length: 21 }, (_, index) => [run(index * 50, index, "L0/eye/see", 1), tick(index * 50 + 1, index, 1)]).flat()
        const one = await Debug().session(agent([LOG[0]!, LOG[1]!, ...lines], [well]), "latest")
        expect(one.signs.found.map(sign => sign.sign)).toEqual(["inference"])
        expect(one.signs.found[0]!.detail).toStartWith("model calls took 2.73 of the time they were made in — more than one worker has; 10 of 30 began with the worker free")
    })
})
