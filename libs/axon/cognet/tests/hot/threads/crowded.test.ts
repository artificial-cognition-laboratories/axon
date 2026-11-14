import type { CognetDefinition, KernelAbi } from "@arcforge/types"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * More lagged worker systems than workers. A worker used to stay taken until
 * its result LANDED, and a lagged result waits ticks to: two lagged systems
 * on one worker, both due in one tick, deadlocked — the tick waited for the
 * second, which waited for the worker, which waited for the first to land
 * after it (found 2026-10-09, Terry's replay hung with five lagged systems
 * on four workers). A worker is free once it replies.
 */

const out = mkdtempSync(join(tmpdir(), "cognet-crowded-"))
const events: Array<{ type: string; data: any }> = []
const ABI = { emit: (type: string, data: unknown) => { events.push({ type: type, data: data }) } } as unknown as KernelAbi
let definition: CognetDefinition

const of = (type: string) => events.filter(event => event.type === type).map(event => event.data)

beforeAll(async () => {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "crowded/entry.ts")], target: "bun", format: "esm", outdir: out })
    if (!built.success) throw new AggregateError(built.logs, "the fixture cognet did not bundle")
    definition = ((await import(built.outputs[0]!.path)) as { default: CognetDefinition }).default
    await definition.load(ABI)
})

afterAll(async () => {
    await definition.unload!()
    rmSync(out, { recursive: true, force: true })
})

describe("lagged worker systems crowding one worker", () => {
    it("all land, each its lag after it started", async () => {
        const tick = () => definition.wake({ stimuli: [], signal: new AbortController().signal })
        for (let k = 0; k < 5; k++) await tick()
        const landed = of("cognet:system:run").filter(run => run.system === "left" || run.system === "right")
        expect(landed.map(run => [run.system, run.tick, run.outcome])).toEqual([["left", 3, "complete"], ["right", 3, "complete"], ["left", 5, "complete"], ["right", 5, "complete"]])
    }, 10_000)
})
