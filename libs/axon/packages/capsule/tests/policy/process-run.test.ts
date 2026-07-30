import { Capsule } from "@axon/capsule"
import type { ProcRunResult } from "@axon/capsule"

describe("Capsule policy — process.run rule evaluation, independent of process.spawn", () => {
    it("true allows any command", async () => {
        const capsule = Capsule({ policy: { process: { run: true } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hello")`) as ProcRunResult
        expect(result.ok).toBe(true)

        await capsule.shutdown()
    })

    it("false denies any command", async () => {
        const capsule = Capsule({ policy: { process: { run: false } } })
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo hello")`) as ProcRunResult
        expect(result.ok).toBe(false)
        expect(result.err).toBe("denied by policy")

        await capsule.shutdown()
    })

    it("allow/deny globs evaluate against the command string, same as spawn", async () => {
        const capsule = Capsule({ policy: { process: { run: { allow: ["echo *"], deny: ["echo bad*"] } } } })
        await capsule.boot()

        const allowed = await capsule.run(`await process.run("echo good")`) as ProcRunResult
        const denied = await capsule.run(`await process.run("echo bad")`) as ProcRunResult

        expect(allowed.ok).toBe(true)
        expect(denied.ok).toBe(false)

        await capsule.shutdown()
    })

    it("allowing spawn does not allow run, and vice versa — the two verbs are independently gated", async () => {
        const capsule = Capsule({ policy: { process: { spawn: true, run: false } } })
        await capsule.boot()

        const spawnResult = await capsule.process.spawn("echo via-spawn").exited
        const runResult = await capsule.run(`await process.run("echo via-run")`) as ProcRunResult

        expect(spawnResult.ok).toBe(true)
        expect(runResult.ok).toBe(false)

        await capsule.shutdown()
    })

    it("the reverse: run allowed, spawn denied", async () => {
        const capsule = Capsule({ policy: { process: { spawn: false, run: true } } })
        await capsule.boot()

        const spawnResult = await capsule.process.spawn("echo via-spawn").exited
        const runResult = await capsule.run(`await process.run("echo via-run")`) as ProcRunResult

        expect(spawnResult.ok).toBe(false)
        expect(runResult.ok).toBe(true)

        await capsule.shutdown()
    })
})
