import { Capsule } from "@arcforge/capsule"

describe("Capsule policy — live update", () => {
    it("a call denied before update() is allowed after granting the rule", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: false } } })
        await capsule.boot()

        const before = await capsule.process.spawn("echo hello").exited
        expect(before.ok).toBe(false)

        await capsule.update({ policy: { shell: { allow: ["*"], spawn: true } } })

        const after = await capsule.process.spawn("echo hello").exited
        expect(after.ok).toBe(true)

        await capsule.shutdown()
    })

    it("a call allowed before update() is denied after revoking the rule", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        const before = await capsule.process.spawn("echo hello").exited
        expect(before.ok).toBe(true)

        await capsule.update({ policy: { shell: { allow: ["*"], spawn: false } } })

        const after = await capsule.process.spawn("echo hello").exited
        expect(after.ok).toBe(false)

        await capsule.shutdown()
    })

    it("updating one policy field does not reset an unrelated field back to default", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["*"], spawn: true } } })
        await capsule.boot()

        // Only touch spawn — run should remain allowed.
        await capsule.update({ policy: { shell: { allow: ["*"], spawn: false } } })

        const spawnResult = await capsule.process.spawn("echo hello").exited
        const runResult = await capsule.run(`await process.run("echo hello")`) as { ok: boolean }

        expect(spawnResult.ok).toBe(false)
        expect(runResult.ok).toBe(true)

        await capsule.shutdown()
    })
})
