import { Clock } from "../../src/clock"
import { Ticks } from "../../src/ticks"
import { describe, it, expect } from "bun:test"

function Recorder() {
    const events: Array<{ event: string; payload: unknown }> = []
    return {
        events,
        emit: ((type: string, data: unknown) => { events.push({ event: type, payload: data }) }) as never,
    }
}


describe("Clock: tick/phase/system", () => {
    it("tick() advances state.tick and returns the callback's result", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })

        const result = await clock.runTick(async () => "done")

        expect(clock.tick).toBe(1)
        expect(result).toBe("done")
    })

    it("tick() emits start then complete on success, in order", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await clock.runTick(async () => {})
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:tick:"))
        expect(types).toEqual(["cognet:tick:start", "cognet:tick:complete"])
    })

    it("tick() emits failed (not complete) and rethrows when the callback throws", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await expect(clock.runTick(async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:tick:"))
        expect(types).toEqual(["cognet:tick:start", "cognet:tick:failed"])
    })

    it("phase() sets state.phase for the duration of the callback", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })
        let phaseDuringCallback: string | null = null

        await clock.runPhase("build", async () => {
            phaseDuringCallback = clock.phase
        })

        // Read back through the annotated binding: the assignment happens
        // inside a callback, so control-flow analysis narrows the variable to
        // its initializer (`null`) at this point even though it is declared
        // `string | null`.
        expect(phaseDuringCallback as string | null).toBe("build")
        expect(clock.phase).toBeNull()
    })

    it("phase() clears state.phase back to null even when the callback throws", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })

        await expect(clock.runPhase("build", async () => { throw new Error("boom") })).rejects.toThrow("boom")

        expect(clock.phase).toBeNull()
    })

    it("phase() emits start/complete with the current tick and phase name", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })
        await clock.runTick(() => clock.runPhase("build", async () => {}))
        await Promise.resolve()

        const start = bus.events.find(e => e.event === "cognet:phase:start")
        expect(start?.payload).toMatchObject({ tick: 1, phase: "build" })
    })

    it("phase() emits failed (not complete) and rethrows when the callback throws", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await expect(clock.runPhase("build", async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:phase:"))
        expect(types).toEqual(["cognet:phase:start", "cognet:phase:failed"])
    })

    it("system() records ONE run when it ends: its start, its duration, its outcome", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await clock.runSystem("render", async () => {})
        await Promise.resolve()

        const records = bus.events.filter(e => e.event.startsWith("cognet:system:"))
        expect(records.map(e => e.event)).toEqual(["cognet:system:run"])
        expect(records[0]!.payload).toMatchObject({ system: "render", outcome: "complete" })
        expect(typeof (records[0]!.payload as Record<string, unknown>).at).toBe("number")
        expect(typeof (records[0]!.payload as Record<string, unknown>).durationMs).toBe("number")
    })

    it("system() records a failed run, with its error, and rethrows", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await expect(clock.runSystem("render", async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const run = bus.events.find(e => e.event === "cognet:system:run")!.payload as Record<string, any>
        expect(run.outcome).toBe("failed")
        expect(run.error.message).toContain("boom")
    })

    it("system() carries what its caller noted, and an async or worker run's own timing", async () => {
        const bus = Recorder()
        const clock = Clock({ ticks: Ticks(), emit: bus.emit })

        await clock.runTick(() => clock.runPhase("build", () => clock.runSystem("render", async note => { note({ reads: [{ entity: "self", component: "body", rev: 3 }] }) })))
        await clock.runSystem("think", async () => {}, { at: 1_000, durationMs: 250, async: true })
        await clock.runSystem("see", async () => {}, { at: 2_000, durationMs: 40, thread: 2 })
        await Promise.resolve()

        const [render, think, see] = bus.events.filter(e => e.event === "cognet:system:run").map(e => e.payload as Record<string, unknown>)
        expect(render).toMatchObject({ tick: 1, phase: "build", system: "render", reads: [{ entity: "self", component: "body", rev: 3 }] })
        expect(think).toMatchObject({ system: "think", at: 1_000, durationMs: 250, async: true })
        expect(see).toMatchObject({ system: "see", at: 2_000, durationMs: 40, thread: 2 })
        expect(see!.async).toBeUndefined()
    })
})

describe("Clock: write attribution", () => {
    it("stamps the running system, and none outside one", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })
        const seen: Array<string | null> = []

        await clock.runTick(async () => {
            await clock.runPhase("feel", async () => {
                seen.push(clock.stamp().system)
                await clock.runSystem("modulate", async () => { seen.push(clock.stamp().system) })
                seen.push(clock.stamp().system)
            })
        })

        expect(seen).toEqual([null, "modulate", null])
    })

    it("restores the outer system when a nested one ends", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })
        let after = null as string | null

        await clock.runSystem("outer", async () => {
            await clock.runSystem("inner", async () => {})
            after = clock.stamp().system
        })

        expect(after).toBe("outer")
        expect(clock.system).toBeNull()
    })

    it("clears the system even when it throws", async () => {
        const clock = Clock({ ticks: Ticks(), emit: () => {} })

        await expect(clock.runSystem("boom", async () => { throw new Error("x") })).rejects.toThrow()

        expect(clock.system).toBeNull()
    })
})
