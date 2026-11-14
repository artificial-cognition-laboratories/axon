import type { CognetDefinition, KernelAbi } from "@arcforge/types"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Worker systems, end to end: the fixture is BUNDLED the way the compile
 * step bundles a cognet, loaded the way the kernel loads one, and its
 * `thread: "worker"` systems run on real worker threads loaded from that
 * same bundle. Nothing is simulated — the claim under test is that the
 * bundle can be its own worker.
 */

const out = mkdtempSync(join(tmpdir(), "cognet-threads-"))
const events: Array<{ type: string; data: any }> = []
const ABI = { emit: (type: string, data: unknown) => { events.push({ type: type, data: data }) } } as unknown as KernelAbi
let definition: CognetDefinition

const wake = () => definition.wake({ stimuli: [], signal: new AbortController().signal } as never)
const runs = (system: string) => events.filter(event => event.type === "cognet:system:run" && event.data.system === system).map(event => event.data)
const joined = () => events.filter(event => event.type.startsWith("cognet:component:") && event.data.component === "joined").map(event => event.data.value)

beforeAll(async () => {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "fixture/entry.ts")], target: "bun", format: "esm", outdir: out })
    if (!built.success) throw new AggregateError(built.logs, "the fixture cognet did not bundle")
    definition = ((await import(built.outputs[0]!.path)) as { default: CognetDefinition }).default
    await definition.load(ABI)
})

afterAll(async () => {
    await definition.unload!()
    rmSync(out, { recursive: true, force: true })
})

describe("worker systems", () => {
    it("run on separate workers at the same time, and land before what reads them", async () => {
        await wake()

        const [left] = runs("measure/left")
        const [right] = runs("measure/right")
        expect(left.outcome).toBe("complete")
        expect(right.outcome).toBe("complete")
        expect(typeof left.thread).toBe("number")
        expect(typeof right.thread).toBe("number")
        expect(left.thread).not.toBe(right.thread)
        // Each spins 60ms; run in order they could not overlap at all.
        expect(left.at < right.at + right.durationMs && right.at < left.at + left.durationMs).toBe(true)
        // What a worker read is recorded, by rev, exactly as on the main thread.
        expect(left.reads.map((read: { component: string }) => read.component)).toContain("frame")

        const order = events.filter(event => event.type === "cognet:system:run").map(event => event.data.system)
        expect(order.indexOf("join")).toBeGreaterThan(order.indexOf("measure/left"))
        expect(order.indexOf("join")).toBeGreaterThan(order.indexOf("measure/right"))
        // 50,000 pixels of frame 1, plus the running total 1; right is 1 × 2.
        expect(joined()).toEqual([50_000 + 1 + 2])

        // Each worker says which OS thread it is — a thread of this process, not the main one.
        const starts = events.filter(event => event.type === "cognet:thread:start").map(event => event.data)
        expect(starts.map(start => start.index).sort()).toEqual([left.thread, right.thread].sort())
        for (const start of starts) {
            expect(start.pid).toBe(process.pid)
            expect(start.tid).not.toBe(process.pid)
            expect(require("node:fs").existsSync(`/proc/${process.pid}/task/${start.tid}`)).toBe(true)
        }
    })

    it("compute exactly what running in order would, tick after tick", async () => {
        await wake()
        // Frame 2: 100,000, total 1 + 2 = 3 — recalled on the worker — and right 2 × 2.
        expect(joined()).toEqual([50_003, 100_000 + 3 + 4])
        expect(runs("measure/left").every(run => run.thread !== undefined)).toBe(true)
    })

    it("fail the tick when one throws, with the worker's error in its record", async () => {
        await expect(wake()).rejects.toThrow("right refuses frame 3")
        const failed = runs("measure/right").at(-1)
        expect(failed.outcome).toBe("failed")
        expect(failed.error.message).toContain("right refuses frame 3")
    })

    it("carry on at the next tick", async () => {
        const before = joined().length
        await wake()
        expect(joined().length).toBe(before + 1)
        expect(runs("measure/right").at(-1).outcome).toBe("complete")
    })
})
