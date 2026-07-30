import { Capsule } from "@axon/capsule"

describe("Capsule policy — process.spawn rule evaluation", () => {
    it("true allows any command", async () => {
        const capsule = Capsule({ policy: { process: { spawn: true } } })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo anything").exited
        expect(exited.ok).toBe(true)

        await capsule.shutdown()
    })

    it("false denies any command", async () => {
        const capsule = Capsule({ policy: { process: { spawn: false } } })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo anything").exited
        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("allow glob matches an allowed command and denies everything else", async () => {
        const capsule = Capsule({ policy: { process: { spawn: { allow: ["echo *"] } } } })
        await capsule.boot()

        const allowed = await capsule.process.spawn("echo hello").exited
        const denied = await capsule.process.spawn("rm -rf /tmp/x").exited

        expect(allowed.ok).toBe(true)
        expect(denied.ok).toBe(false)

        await capsule.shutdown()
    })

    it("deny takes precedence over allow for the same command", async () => {
        const capsule = Capsule({
            policy: { process: { spawn: { allow: ["*"], deny: ["rm *"] } } },
        })
        await capsule.boot()

        const allowed = await capsule.process.spawn("echo hello").exited
        const denied = await capsule.process.spawn("rm -rf /tmp/x").exited

        expect(allowed.ok).toBe(true)
        expect(denied.ok).toBe(false)

        await capsule.shutdown()
    })

    it("an allow list with no matching pattern denies the command", async () => {
        const capsule = Capsule({ policy: { process: { spawn: { allow: ["npm *"] } } } })
        await capsule.boot()

        const exited = await capsule.process.spawn("bun test").exited
        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("process.spawn (in-sandbox) is gated by the same rule as capsule.proc.spawn", async () => {
        const capsule = Capsule({ policy: { process: { spawn: { allow: ["echo *"] } } } })
        await capsule.boot()

        const allowed = await capsule.run(`
            const proc = process.spawn("echo hello")
            await proc.exited
        `)
        const denied = await capsule.run(`
            const proc = process.spawn("rm -rf /tmp/x")
            await proc.exited
        `)

        expect((allowed as { ok: boolean }).ok).toBe(true)
        expect((denied as { ok: boolean }).ok).toBe(false)

        await capsule.shutdown()
    })
})
