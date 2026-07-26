import { Ecs } from "../../../../src/cognet/ecs"

function Recorder() {
    const events: Array<{ event: string; payload: unknown }> = []
    return {
        events,
        emit: ((type: string, data: unknown) => { events.push({ event: type, payload: data }) }) as never,
    }
}


describe("Ecs: loop (tick/phase/system)", () => {
    it("tick() advances state.tick and returns the callback's result", async () => {
        const ecs = Ecs({ emit: () => {} })

        const result = await ecs.tick(async () => "done")

        expect(ecs.state.tick).toBe(1)
        expect(result).toBe("done")
    })

    it("tick() emits start then complete on success, in order", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await ecs.tick(async () => {})
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:tick:"))
        expect(types).toEqual(["cognet:tick:start", "cognet:tick:complete"])
    })

    it("tick() emits failed (not complete) and rethrows when the callback throws", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await expect(ecs.tick(async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:tick:"))
        expect(types).toEqual(["cognet:tick:start", "cognet:tick:failed"])
    })

    it("phase() sets state.phase for the duration of the callback", async () => {
        const ecs = Ecs({ emit: () => {} })
        let phaseDuringCallback: string | null = null

        await ecs.phase("build", async () => {
            phaseDuringCallback = ecs.state.phase
        })

        expect(phaseDuringCallback).toBe("build")
        expect(ecs.state.phase).toBeNull()
    })

    it("phase() clears state.phase back to null even when the callback throws", async () => {
        const ecs = Ecs({ emit: () => {} })

        await expect(ecs.phase("build", async () => { throw new Error("boom") })).rejects.toThrow("boom")

        expect(ecs.state.phase).toBeNull()
    })

    it("phase() emits start/complete with the current tick and phase name", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })
        await ecs.tick(() => ecs.phase("build", async () => {}))
        await Promise.resolve()

        const start = bus.events.find(e => e.event === "cognet:phase:start")
        expect(start?.payload).toMatchObject({ tick: 1, phase: "build" })
    })

    it("phase() emits failed (not complete) and rethrows when the callback throws", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await expect(ecs.phase("build", async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:phase:"))
        expect(types).toEqual(["cognet:phase:start", "cognet:phase:failed"])
    })

    it("system() emits complete with a durationMs field; start has none", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await ecs.system("render", async () => {})
        await Promise.resolve()

        const start = bus.events.find(e => e.event === "cognet:system:start")
        const complete = bus.events.find(e => e.event === "cognet:system:complete")

        expect((start?.payload as Record<string, unknown>).durationMs).toBeUndefined()
        expect(typeof (complete?.payload as Record<string, unknown>).durationMs).toBe("number")
    })

    it("system() emits failed (not complete) and rethrows when the callback throws", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await expect(ecs.system("render", async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await Promise.resolve()

        const types = bus.events.map(e => e.event).filter(e => e.startsWith("cognet:system:"))
        expect(types).toEqual(["cognet:system:start", "cognet:system:failed"])
    })

    it("system() telemetry reflects the enclosing tick and phase", async () => {
        const bus = Recorder()
        const ecs = Ecs({ emit: bus.emit })

        await ecs.tick(() => ecs.phase("build", () => ecs.system("render", async () => {})))
        await Promise.resolve()

        const start = bus.events.find(e => e.event === "cognet:system:start")
        expect(start?.payload).toMatchObject({ tick: 1, phase: "build", system: "render" })
    })
})
