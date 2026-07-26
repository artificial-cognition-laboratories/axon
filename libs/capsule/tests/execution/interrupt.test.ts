import { Capsule } from "@axon/capsule"

describe("Capsule interrupt", () => {
    it("rejects the run when interrupt() is called while a cooperative run is in flight", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const runPromise = capsule.run(`
            for (let i = 0; i < 100; i++) {
                if (signal.aborted) throw new Error("should not surface — host rejects first")
                await new Promise(r => setTimeout(r, 10))
            }
            "completed"
        `)

        setTimeout(() => capsule.interrupt(), 50)

        await expect(runPromise).rejects.toThrow("capsule run aborted")

        await capsule.shutdown()
    })

    it("is a no-op when no run is active", async () => {
        const capsule = Capsule()
        await capsule.boot()

        // Must not throw — interrupting an idle capsule is valid, does nothing.
        capsule.interrupt()

        const result = await capsule.run("1")
        expect(result).toBe(1)

        await capsule.shutdown()
    })

    it("supports aborting via an explicit AbortSignal passed to run()", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const controller = new AbortController()
        const runPromise = capsule.run("await new Promise(r => setTimeout(r, 5000))", { signal: controller.signal })

        setTimeout(() => controller.abort(), 50)

        await expect(runPromise).rejects.toThrow("capsule run aborted")

        await capsule.shutdown()
    })

    it("rejects immediately if the signal is already aborted before run() is called", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const controller = new AbortController()
        controller.abort()

        await expect(capsule.run("1", { signal: controller.signal })).rejects.toThrow("capsule run aborted")

        await capsule.shutdown()
    })

    it("rejects on timeout without needing an explicit interrupt", async () => {
        const capsule = Capsule()
        await capsule.boot()

        await expect(
            capsule.run("await new Promise(r => setTimeout(r, 5000))", { timeout: 50 })
        ).rejects.toThrow("timed out")

        await capsule.shutdown()
    })

    it("does not affect a second run started after the first was interrupted", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const first = capsule.run("await new Promise(r => setTimeout(r, 5000))")
        setTimeout(() => capsule.interrupt(), 50)
        await expect(first).rejects.toThrow()

        const second = await capsule.run("42")
        expect(second).toBe(42)

        await capsule.shutdown()
    })

    it("kills an in-flight process.run command without recycling the capsule", async () => {
        const capsule = Capsule({ policy: { process: { run: true } } })
        await capsule.boot()
        const pid = capsule.main.pid
        const events: string[] = []
        const off = capsule.onAny(event => events.push(event.type))

        const run = capsule.run(`await process.run("sleep 10"); "unreachable"`)
        setTimeout(() => capsule.interrupt(), 50)

        await expect(run).rejects.toThrow("capsule run aborted")
        expect(capsule.main.pid).toBe(pid)
        expect(events).toContain("capsule:cmd:interrupt:requested")
        expect(events).toContain("capsule:cmd:interrupted")
        expect(events).not.toContain("capsule:cmd:hard-killed")

        off()
        await capsule.shutdown()
    })

    it("replaces the capsule when arbitrary JavaScript cannot cooperate", async () => {
        const capsule = Capsule()
        await capsule.boot()
        const pid = capsule.main.pid
        const events: string[] = []
        const off = capsule.onAny(event => events.push(event.type))

        const run = capsule.run(`await new Promise(r => setTimeout(r, 10_000)); "unreachable"`)
        setTimeout(() => capsule.interrupt(), 50)

        await expect(run).rejects.toThrow("capsule run aborted")
        expect(capsule.main.pid).not.toBe(pid)
        expect(events).toContain("capsule:cmd:hard-killed")
        expect(await capsule.run("40 + 2")).toBe(42)

        off()
        await capsule.shutdown()
    })
})
