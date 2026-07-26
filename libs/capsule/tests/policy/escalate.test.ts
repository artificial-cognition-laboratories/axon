import { Capsule } from "@axon/capsule"
import type { EscalationCall } from "@axon/capsule"

describe("Capsule policy — escalate", () => {
    it("calls the escalate callback with the right shape and allows when it resolves true", async () => {
        const calls: EscalationCall[] = []
        const capsule = Capsule({
            policy: { process: { spawn: "escalate" } },
            escalate: async call => {
                calls.push(call)
                return true
            },
        })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo hello").exited

        expect(exited.ok).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.fn).toBe("process.spawn")
        expect(calls[0]?.args).toEqual(["echo hello"])
        expect(typeof calls[0]?.id).toBe("string")

        await capsule.shutdown()
    })

    it("denies when the escalate callback resolves false", async () => {
        const capsule = Capsule({
            policy: { process: { spawn: "escalate" } },
            escalate: async () => false,
        })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo hello").exited
        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("defaults to deny when no escalate callback is configured at all", async () => {
        const capsule = Capsule({
            policy: { process: { spawn: "escalate" } },
            // no escalate callback
        })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo hello").exited
        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("defaults to deny when the escalate callback throws", async () => {
        const capsule = Capsule({
            policy: { process: { spawn: "escalate" } },
            escalate: async () => { throw new Error("boom") },
        })
        await capsule.boot()

        const exited = await capsule.process.spawn("echo hello").exited
        expect(exited.ok).toBe(false)

        await capsule.shutdown()
    })

    it("each escalation is independent — one denial does not affect the next call's decision", async () => {
        let call = 0
        const capsule = Capsule({
            policy: { process: { spawn: "escalate" } },
            escalate: async () => {
                call++
                return call === 2 // deny first, allow second
            },
        })
        await capsule.boot()

        const first = await capsule.process.spawn("echo one").exited
        const second = await capsule.process.spawn("echo two").exited

        expect(first.ok).toBe(false)
        expect(second.ok).toBe(true)

        await capsule.shutdown()
    })
})
