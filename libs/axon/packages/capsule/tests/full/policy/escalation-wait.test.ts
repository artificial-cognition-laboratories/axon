import { describe, expect, test } from "bun:test"
import { Capsule } from "@arcforge/capsule"

describe("policy escalation waiting", () => {
    test("keeps concurrent requests pending past 30 seconds and honors late answers", async () => {
        const answers: Array<(allow: boolean) => void> = []
        const ready = Promise.withResolvers<void>()
        const capsule = Capsule({
            policy: { shell: { allow: ["*"], spawn: "escalate" } },
            escalate: () => new Promise<boolean>(resolve => {
                answers.push(resolve)
                if (answers.length === 2) ready.resolve()
            }),
        })
        await capsule.boot()
        let completed = 0
        try {
            const first = capsule.process.spawn("echo allowed").exited.then(result => {
                completed++
                return result
            })
            const second = capsule.process.spawn("echo denied").exited.then(result => {
                completed++
                return result
            })
            await ready.promise
            await Bun.sleep(31_000)
            expect(completed).toBe(0)

            answers[0]!(true)
            answers[1]!(false)
            expect((await first).ok).toBe(true)
            expect((await second).ok).toBe(false)
        } finally {
            for (const answer of answers) answer(false)
            await capsule.shutdown()
        }
    }, 40_000)
})
