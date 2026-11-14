import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonBus } from "@arcforge/core"
import { AxonSession } from "../../src/session"
import { home } from "../../src/home"
import { Decoder, Encoder, TelemetryRing } from "../../src/telemetry"
import { ring } from "./support/ring"

/**
 * The telemetry tier: high-rate cognet events in a bounded binary ring
 * instead of the log. What matters is that they read back as the log would
 * have given them, that the ring stays inside its bound, and that a resumed
 * session neither reuses a seq nor appends into a segment it cannot extend.
 */

const run = {
    type: "cognet:system:run",
    time: { ms: 1_700_000_000_123.5, seq: 41 },
    data: {
        tick: 7,
        phase: null,
        system: "L0/world/map/map",
        at: 1_700_000_000_100,
        durationMs: 3.25,
        outcome: "complete",
        thread: 1,
        reads: [{ entity: "camera", component: "L0/sense/visual/sight", rev: 1_234 }],
    },
}

const field = {
    type: "cognet:component:update",
    time: { ms: 1_700_000_000_200, seq: 42 },
    data: {
        tick: 7, phase: null, system: "L0/world/map/map", entity: "camera", component: "L0/world/map/surprise", rev: 99,
        value: {
            cols: 4, rows: 2, shape: "scalar",
            values: [0, 0.62, 1, 0.25, -0.5, 3.75, 12, 0.01],
            confidence: [1, 1, 0, 1, 1, 1, 0, 1],
            labels: ["unknown", "kind 1"],
            of: { channel: "/eye", seq: 9 },
            missing: undefined,
            note: "x".repeat(200),
        },
    },
}

function session(root: string, sessionId: string) {
    return AxonSession({
        blueprint: { agent: { name: "@test/agent", version: "0.0.0" }, paths: { root: root, data: "data" }, session: { id: sessionId } } as never,
        bus: AxonBus(),
    })
}

describe("telemetry codec", () => {
    it("reads an event back exactly as the log would have", () => {
        const encoder = Encoder()
        encoder.begin()
        encoder.encode(run)
        encoder.encode(field)
        const { events, used } = Decoder({ numbers: "array" }).decode(encoder.take())
        expect(events).toEqual([run, JSON.parse(JSON.stringify(field))])
        expect(used).toBeGreaterThan(0)
    })

    it("hands a run of numbers back as a typed array when asked", () => {
        const encoder = Encoder()
        encoder.begin()
        encoder.encode(field)
        const [event] = Decoder({ numbers: "typed" }).decode(encoder.take()).events
        const value = (event!.data as { value: { values: unknown; confidence: unknown } }).value
        expect(value.values).toBeInstanceOf(Float64Array)
        expect(Array.from(value.values as Float64Array)).toEqual(field.data.value.values)
        expect(value.confidence).toBeInstanceOf(Uint8Array)
    })

    it("decodes from a pooled Node Buffer at an odd offset — what a file reader hands it", () => {
        const encoder = Encoder()
        encoder.begin()
        encoder.encode({ ...field, data: { ...field.data, value: { ...field.data.value, values: [-300, 2, 3, 4] } } })
        const bytes = encoder.take()
        // Buffer.concat lands small buffers in a shared pool; one byte in front makes the offset odd.
        const pooled = Buffer.concat([Buffer.from([0]), Buffer.from(bytes)]).subarray(1)
        expect(pooled.byteOffset % 2).toBe(1)
        const [event] = Decoder({ numbers: "typed" }).decode(pooled).events
        const values = (event!.data as { value: { values: Int16Array } }).value.values
        expect(values).toBeInstanceOf(Int16Array)
        expect(Array.from(values)).toEqual([-300, 2, 3, 4])
    })

    it("decodes what is complete and leaves a torn record for the next read", () => {
        const encoder = Encoder()
        encoder.begin()
        encoder.encode(run)
        encoder.encode(field)
        const bytes = encoder.take()
        const decoder = Decoder({ numbers: "array" })
        const first = decoder.decode(bytes.subarray(0, bytes.length - 5))
        expect(first.events.map(event => event.time.seq)).toEqual([41])
        const second = decoder.decode(bytes.subarray(first.used))
        expect(second.events.map(event => event.time.seq)).toEqual([42])
    })

    it("is a fraction of the JSON it replaces", () => {
        const encoder = Encoder()
        encoder.begin()
        const many = Array.from({ length: 200 }, (_, index) => ({ ...field, time: { ms: index, seq: index }, data: { ...field.data, value: { ...field.data.value, values: Array.from({ length: 2304 }, (_, cell) => Math.round(Math.sin(cell + index) * 100) / 100) } } }))
        for (const event of many) encoder.encode(event)
        const json = many.map(event => JSON.stringify(event)).join("\n").length
        expect(encoder.take().length).toBeLessThan(json)
    })
})

describe("telemetry ring", () => {
    it("rolls to self-contained segments and stays inside its bound", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-telemetry-"))
        try {
            const failures: unknown[] = []
            const kept = TelemetryRing({ root: root, sessionId: "s", maxBytes: 20 * 1024 * 1024, failed: cause => failures.push(cause) })
            const big = { ...field, data: { ...field.data, value: { ...field.data.value, values: Array.from({ length: 100_000 }, () => Math.random()) } } }
            for (let seq = 0; seq < 60; seq++) kept.record({ ...big, time: { ms: seq, seq: seq } })
            await kept.drain()
            expect(failures).toEqual([])
            const segments = home.data.telemetry.existing(root, "s")
            expect(segments.length).toBeGreaterThan(1)
            expect(segments.reduce((sum, segment) => sum + segment.bytes, 0)).toBeLessThanOrEqual(20 * 1024 * 1024 + 9 * 1024 * 1024)
            // The oldest went; what is left reads from any segment's start, newest last.
            const events = await ring(root, "s")
            expect(events.at(-1)!.time.seq).toBe(59)
            expect(events[0]!.time.seq).toBeGreaterThan(0)
            expect(await kept.last()).toBe(59)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

describe("telemetry in the session", () => {
    it("keeps high-rate events out of the log, in the window and the ring", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-telemetry-"))
        try {
            const opened = await session(root, "s1")
            await opened.commit("cognet:system:run", run.data as never)
            await opened.commit("cognet:schedule:declare", { systems: [], components: [], queries: [] } as never)
            expect(opened.kernelLog.map(event => event.type)).toEqual(["cognet:system:run", "cognet:schedule:declare"])
            await opened.end()

            const log = await readFile(join(root, "data", "sessions", "s1.jsonl"), "utf-8")
            expect(log.includes("cognet:system:run")).toBe(false)
            expect(log.includes("cognet:schedule:declare")).toBe(true)
            const events = await ring(join(root, "data"), "s1")
            expect(events.map(event => event.type)).toEqual(["cognet:system:run"])
            expect(events[0]!.data).toEqual(run.data)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("resumes past the ring's seqs, in a new segment", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-telemetry-"))
        try {
            const first = await session(root, "s1")
            for (let tick = 0; tick < 5; tick++) await first.commit("cognet:tick:complete", { tick: tick, durationMs: 1 })
            await first.end()
            const before = await ring(join(root, "data"), "s1")
            const highest = before.at(-1)!.time.seq

            const second = await session(root, "s1")
            const next = await second.commit("cognet:tick:complete", { tick: 5, durationMs: 1 })
            await second.end()
            expect(next.time.seq).toBeGreaterThan(highest)
            expect(home.data.telemetry.existing(join(root, "data"), "s1")).toHaveLength(2)
            const after = await ring(join(root, "data"), "s1")
            expect(new Set(after.map(event => event.time.seq)).size).toBe(after.length)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
