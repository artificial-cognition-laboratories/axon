import { Capsule } from "@arcforge/capsule"

/**
 * The regression this file exists for.
 *
 * Every other spawn test used `echo` and awaited `.exited` — so the entire
 * suite would have passed if spawn() never launched anything at all, and
 * passed again if a spawned process died the instant its block ended. Nothing
 * asserted the one property `spawn` exists to provide: that a background
 * process is STILL THERE afterwards.
 *
 * That gap is what let a handle report `status: "running"` with no pid before
 * the spawn had happened, which an agent read as "it exited immediately" and
 * reported to the user as an environment that cannot hold ambient processes.
 * The process was fine. The reporting was not.
 *
 * So these tests assert liveness against the OS, not against our own
 * bookkeeping: `kill -0 <pid>` is the only witness that cannot agree with a
 * bug in the code under test.
 */
describe("Capsule process.spawn — ambient lifetime", () => {
    /** Is this pid alive, according to the OS rather than according to us? */
    function alive(pid: number): boolean {
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }

    /**
     * Wait for the OS to actually reap a killed process.
     *
     * `killAll()` signals and returns; reaping is the kernel's, and asserting
     * the instant shutdown() resolves reads a process that is dying but not
     * yet dead. Polling to a deadline rather than sleeping a fixed span keeps
     * this fast when it passes and still fails honestly when the process is
     * genuinely leaked.
     */
    async function reaped(pid: number, timeoutMs = 2_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (!alive(pid)) return true
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return !alive(pid)
    }

    it("a spawned process is still running after its block ends", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        const spawned = await capsule.run(`
            const proc = process.spawn("sleep 30")
            const started = await proc.started
            ;({ procId: proc.procId, pid: started.pid, ok: started.ok })
        `) as { procId: string; pid: number; ok: boolean }

        expect(spawned.ok).toBe(true)
        expect(typeof spawned.pid).toBe("number")

        // A SEPARATE block — the one the old suite never ran.
        const seen = await capsule.run(`
            const proc = process.proc(${JSON.stringify(spawned.procId)})
            ;({ status: proc?.status, pid: proc?.pid })
        `) as { status: string; pid: number }

        expect(seen.status).toBe("running")
        expect(seen.pid).toBe(spawned.pid)
        expect(alive(spawned.pid)).toBe(true)

        await capsule.shutdown()
        expect(await reaped(spawned.pid)).toBe(true)
    })

    it("shutdown reaps the processes the agent left running", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        const proc = capsule.process.spawn("sleep 30")
        const started = await proc.started
        expect(started.ok).toBe(true)

        await capsule.shutdown()

        // Not a nicety: an agent that spawns ambient work every session and
        // leaks it leaves a machine full of orphans. This failed before
        // `detached` — `shell: true` meant kill() signalled the SHELL and the
        // real command was orphaned onto init, outliving the capsule entirely.
        expect(await reaped(started.pid!)).toBe(true)
    })

    it("kill() reaps the COMMAND, not just the shell wrapping it", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        // `shell: true` makes the tracked child `/bin/sh -c "sleep 30"`. The
        // pid we hold is the shell's; the sleep is its child. Signalling only
        // the shell leaves the sleep running under init — alive, untracked,
        // and invisible to every surface. So this asserts against the
        // GRANDCHILD, which is the process the agent actually asked for.
        const proc = capsule.process.spawn("sleep 30")
        const started = await proc.started
        const shellPid = started.pid!

        const kids = (await Bun.$`ps -o pid= --ppid ${shellPid}`.text().catch(() => ""))
            .split("\n").map(line => Number(line.trim())).filter(Boolean)
        expect(kids.length).toBeGreaterThan(0)
        const workload = kids[0]!

        proc.kill()
        await proc.exited

        expect(await reaped(shellPid)).toBe(true)
        expect(await reaped(workload)).toBe(true)

        await capsule.shutdown()
    })

    it("a refused spawn settles started() with the reason, rather than hanging", async () => {
        const capsule = Capsule() // no policy — default deny
        await capsule.boot()

        const proc = capsule.process.spawn("sleep 30")
        const started = await proc.started

        // It SETTLES. Before `started` existed the only settled signal was
        // `exited`, so a caller that wanted to know whether its spawn worked
        // had to wait for a process that was never going to run.
        expect(started.ok).toBe(false)
        expect(started.pid).toBeUndefined()
        // And it says WHY. "denied" alone leaves a model guessing; naming the
        // rule lets it rewrite the call.
        expect(started.err).toContain("denied by policy")
        expect(proc.status).toBe("exited")

        await capsule.shutdown()
    })

    it("process.procs() shows the agent every process it owns, across blocks", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        await capsule.run(`
            const a = process.spawn("sleep 30")
            const b = process.spawn("sleep 30")
            await Promise.all([a.started, b.started])
        `)

        const listed = await capsule.run(`
            process.procs()
                .filter(p => p.command === "sleep 30")
                .map(p => ({ status: p.status, hasPid: typeof p.pid === "number" }))
        `) as { status: string; hasPid: boolean }[]

        expect(listed).toHaveLength(2)
        expect(listed.every(p => p.status === "running" && p.hasPid)).toBe(true)

        await capsule.shutdown()
    })
})
