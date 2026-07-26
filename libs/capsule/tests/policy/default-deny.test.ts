import { Capsule } from "@axon/capsule"
import type { ProcRunResult } from "@axon/capsule"

/**
 * The single most important invariant in the capsule: capability is never
 * granted by omission. With no policy configured at all, every gated call
 * denies — process.spawn, process.run, any custom tool namespace.
 */
describe("Capsule default deny", () => {
    it("denies process.spawn with no policy at all", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const proc = capsule.process.spawn("echo should-not-run")
        const exited = await proc.exited

        expect(exited.ok).toBe(false)
        expect(exited.exitCode).toBe(-1)

        await capsule.shutdown()
    })

    it("denies process.run with no policy at all", async () => {
        const capsule = Capsule()
        await capsule.boot()

        const result = await capsule.run(`await process.run("echo should-not-run")`) as ProcRunResult

        expect(result.ok).toBe(false)
        expect(result.err).toBe("denied by policy")

        await capsule.shutdown()
    })

    it("denies a custom tool call when its namespace has no policy entry", async () => {
        const capsule = Capsule({
            tools: [{
                namespace: "math",
                scope: { name: "math", members: [{ name: "add", declaration: "function add(): unknown" }] },
                source: `export default { exports: { add: (a, b) => a + b } }`,
            }],
            // policy.tools has no "math" entry
        })
        await capsule.boot()

        await expect(capsule.run("math.add(1, 2)")).rejects.toThrow("denied by policy")

        await capsule.shutdown()
    })

    it("denies process.spawn even when other policy fields are configured but process.spawn is not", async () => {
        const capsule = Capsule({
            policy: { tools: { math: true } }, // process defaults to spawn:false/run:false
        })
        await capsule.boot()

        const proc = capsule.process.spawn("echo should-not-run")
        const exited = await proc.exited

        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("a policy rule object with no matching allow pattern denies, even with allow entries for other subjects", async () => {
        const capsule = Capsule({
            policy: { process: { spawn: { allow: ["npm *"] }, run: true } },
        })
        await capsule.boot()

        const proc = capsule.process.spawn("rm -rf /")
        const exited = await proc.exited

        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })
})
