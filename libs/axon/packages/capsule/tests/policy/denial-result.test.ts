import { Capsule } from "@arcforge/capsule"

/**
 * A refused call is reported as a refusal — on the RESULT, not only on the bus.
 *
 * `ok` used to mean "did the block throw", which is the wrong question for a
 * denial: nothing throws. `process.spawn()` hands back a handle whose status is
 * `exited`, and `process.run()` returns `{ ok: false }` as a VALUE. So a policy
 * could refuse every call a block made and the layer above still recorded
 * success — `cognet:action:result` with `ok: true`, an ordinary tool call in
 * the timeline, and a user whose own policy had silently stopped their agent.
 *
 * This is the seam that fix rests on: the capsule reports what it refused, so
 * the kernel can decide the block did not succeed. Asserted here rather than
 * only at the kernel because this is where the fact originates — and because
 * the bug's whole shape was a real event that no consumer could reach.
 */
describe("Capsule exec — denials on the result", () => {
    it("reports a refused spawn as a denial", async () => {
        const capsule = Capsule() // no policy — default deny
        await capsule.boot()

        const result = await capsule.exec(`process.spawn("sleep 30")`)

        expect(result.denials).toHaveLength(1)
        expect(result.denials[0]!.fn).toBe("shell.run:sleep")
        // The RULE, not just "denied": a missing rule and an explicit deny
        // imply opposite fixes, and the model can act on the difference.
        expect(result.denials[0]!.rule).toBe("no-policy")

        await capsule.shutdown()
    })

    it("reports a refused run as a denial", async () => {
        // `run` already returned {ok:false} as a value, so it LOOKED handled —
        // but nothing above the capsule could see that a policy was the cause
        // rather than the command itself failing.
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.exec(`await process.run("sleep 1")`)

        expect(result.denials).toHaveLength(1)
        expect(result.denials[0]!.fn).toBe("shell.run:sleep")

        await capsule.shutdown()
    })

    it("carries one entry per refused call", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.exec(`
            process.spawn("sleep 30")
            process.spawn("tail -f /dev/null")
        `)

        // Not collapsed to one: two refusals is a policy worth looking at, and
        // a surface that showed a single row would hide the scale of it.
        expect(result.denials).toHaveLength(2)
        expect(result.denials.map(d => d.fn)).toEqual(["shell.run:sleep", "shell.run:tail"])

        await capsule.shutdown()
    })

    it("is empty when nothing was refused", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        const result = await capsule.exec(`await process.run("echo hello")`)
        expect(result.denials).toEqual([])

        await capsule.shutdown()
    })

    it("attributes a denial to the block that caused it, not a concurrent one", async () => {
        // Blocks run concurrently (kernel runBatch), so correlation goes
        // through the execution store's async context rather than a shared
        // "current id" — which would attribute one block's denial to whichever
        // started last.
        const capsule = Capsule({ policy: { shell: { allow: ["echo"], spawn: true } } })
        await capsule.boot()

        const [denied, allowed] = await Promise.all([
            capsule.exec(`await process.run("sleep 1")`),
            capsule.exec(`await process.run("echo fine")`),
        ])

        expect(denied.denials).toHaveLength(1)
        expect(allowed.denials).toEqual([])

        await capsule.shutdown()
    })
})
