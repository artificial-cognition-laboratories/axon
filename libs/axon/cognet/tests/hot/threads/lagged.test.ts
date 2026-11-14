import type { CognetDefinition, KernelAbi } from "@arcforge/types"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A lagged worker system, end to end: bundled and loaded as a real cognet,
 * its heavy run on a real worker thread. The claims: the ticks do not wait
 * for it, its writes land exactly `lag` ticks after it starts, it streams
 * every reading written meanwhile, and a run longer than its lag is waited
 * for and recorded — never landed early or late.
 */

const out = mkdtempSync(join(tmpdir(), "cognet-lagged-"))
const events: Array<{ type: string; data: any }> = []
const ABI = { emit: (type: string, data: unknown) => { events.push({ type: type, data: data }) } } as unknown as KernelAbi
let definition: CognetDefinition

const of = (type: string) => events.filter(event => event.type === type).map(event => event.data)
const runs = (system: string) => of("cognet:system:run").filter(run => run.system === system)
const believed = () => of("cognet:component:update").filter(write => write.component === "seen").at(-1)?.value as number[]

beforeAll(async () => {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "lagged/entry.ts")], target: "bun", format: "esm", outdir: out })
    if (!built.success) throw new AggregateError(built.logs, "the fixture cognet did not bundle")
    definition = ((await import(built.outputs[0]!.path)) as { default: CognetDefinition }).default
    await definition.load(ABI)
})

afterAll(async () => {
    await definition.unload!()
    rmSync(out, { recursive: true, force: true })
})

describe("a lagged worker system", () => {
    const tick = () => definition.wake({ stimuli: [], signal: new AbortController().signal })

    it("lands its writes exactly its lag after it starts, and the ticks between do not wait for it", async () => {
        for (let k = 0; k < 3; k++) await tick()
        expect(of("cognet:tick:start").map(opened => opened.tick)).toEqual([1, 2, 3])

        const [ran] = runs("integrate")
        expect(ran.outcome).toBe("complete")
        expect(typeof ran.thread).toBe("number")
        expect(ran.lag).toBe(2)
        // Landed in tick 3: started in tick 1, two ticks before.
        expect(ran.tick).toBe(3)
        // Seen from tick 3 on, never before: 0, 0, then reading 1 — and seen in the very tick it lands.
        expect(believed()).toEqual([0, 0, 1])

        // Tick 1 started it and finished without it: far less than its 80ms.
        const [first] = of("cognet:tick:complete")
        expect(first.durationMs).toBeLessThan(ran.durationMs)
    })

    it("waits for a run still going when its tick comes, and records the overrun on that tick", () => {
        // Ticks 2 and 3 ran back to back, well inside its 80ms: tick 3 had to wait.
        const [overrun] = of("cognet:system:overrun")
        expect(overrun).toMatchObject({ tick: 3, system: "integrate", lag: 2 })
        expect(overrun.waitedMs).toBeGreaterThan(0)
        const third = of("cognet:tick:complete").find(complete => complete.tick === 3)
        expect(third.held).toEqual([{ system: "integrate", ms: overrun.waitedMs }])
    })

    it("streams every reading written while it was away, a repeated one included", async () => {
        for (let k = 0; k < 4; k++) await tick()
        // Run 2 (tick 3 to 5) took readings 2 and 3: 1 + 5. Run 3 (tick 5 to 7) took readings 4 and 5, where
        // reading 4 repeated 3: 6 + 3 + 5 — the repeat counted, though it changed nothing.
        expect(runs("integrate").map(run => run.tick)).toEqual([3, 5, 7])
        expect(believed()).toEqual([0, 0, 1, 1, 6, 6, 14])
    })
})
