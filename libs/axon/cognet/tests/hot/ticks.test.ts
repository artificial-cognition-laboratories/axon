import { describe, expect, it } from "bun:test"
import { Clock } from "../../src/clock"
import { Ticks } from "../../src/ticks"

describe("Ticks", () => {
    it("starts before the first tick", () => {
        expect(Ticks().current()).toBe(0)
    })

    it("counts monotonically", () => {
        const ticks = Ticks()

        expect(ticks.next()).toBe(1)
        expect(ticks.next()).toBe(2)
        expect(ticks.current()).toBe(2)
    })
})

describe("Clock + Ticks", () => {
    /**
     * The defect this exists to prevent: Clock is built per wake, and a
     * continuous cognet's wake is ONE tick. A counter owned by Clock restarted
     * at zero every time, so every event a 20Hz control loop ever emitted was
     * stamped tick 1 — the flame graph could not order two ticks, and nothing
     * keyed on tick could replay.
     */
    it("keeps counting across the separate clocks that successive wakes build", async () => {
        const ticks = Ticks()
        const seen: number[] = []
        const emit = ((type: string, data: any) => {
            if (type === "cognet:tick:start") seen.push(data.tick)
        }) as any

        for (let wake = 0; wake < 3; wake++) {
            const clock = Clock({ ticks: ticks, emit: emit })
            await clock.runTick(async () => {})
        }

        expect(seen).toEqual([1, 2, 3])
    })

    it("stamps phases with the tick in progress", async () => {
        const ticks = Ticks()
        const stamps: Array<{ tick: number; phase: string | null }> = []
        const emit = ((type: string, data: any) => {
            if (type === "cognet:phase:start") stamps.push({ tick: data.tick, phase: data.phase })
        }) as any

        const clock = Clock({ ticks: ticks, emit: emit })
        await clock.runTick(async () => { await clock.runPhase("sense", async () => {}) })
        await clock.runTick(async () => { await clock.runPhase("act", async () => {}) })

        expect(stamps).toEqual([
            { tick: 1, phase: "sense" },
            { tick: 2, phase: "act" },
        ])
    })
})
