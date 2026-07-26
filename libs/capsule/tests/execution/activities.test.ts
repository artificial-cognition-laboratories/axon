import { Capsule } from "@axon/capsule"
import type { CapsuleEvent } from "@axon/capsule"

function collectActivityEvents(capsule: ReturnType<typeof Capsule>) {
    const events: CapsuleEvent["capsule:activity"][] = []
    capsule.on("capsule:activity", e => events.push(e))
    return events
}

describe("Capsule activities", () => {
    it("emits declared then done for an explicit activity lifecycle, correlated to the run", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            const act = axon.activity("file:patch", { path: "src/config.ts" })
            act.done({ diff: "- a\\n+ b" })
            "ok"
        `)

        expect(events).toHaveLength(2)
        expect(events[0]?.phase).toBe("declared")
        expect(events[0]?.activity).toBe("file:patch")
        expect(events[0]?.data).toEqual({ path: "src/config.ts" })
        expect(events[1]?.phase).toBe("done")
        expect(events[1]?.data).toEqual({ diff: "- a\n+ b" })
        expect(events[1]?.id).toBe(events[0]?.id ?? "")
        expect(typeof events[0]?.commandId).toBe("string")

        await capsule.shutdown()
    })

    it("auto-settles an unclosed activity as done when the command completes", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`axon.activity("file:read", { path: "a.txt" }); 1`)

        expect(events.map(e => e.phase)).toEqual(["declared", "done"])

        await capsule.shutdown()
    })

    it("auto-settles an open activity as failed when the script throws", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await expect(
            capsule.run(`axon.activity("file:write", { path: "b.txt" }); throw new Error("boom")`),
        ).rejects.toThrow("boom")

        expect(events.map(e => e.phase)).toEqual(["declared", "failed"])
        expect(events[1]?.error).toBe("boom")

        await capsule.shutdown()
    })

    it("done() is idempotent — auto-settle never double-fires", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            const act = axon.activity("note", { text: "once" })
            act.done()
            act.done()
            "ok"
        `)

        expect(events).toHaveLength(2)

        await capsule.shutdown()
    })

    it("uses a caller-supplied command id, so activities correlate to the caller's own span", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`axon.activity("note", { text: "hi" }); 1`, { id: "my-entry-id" })

        expect(events).toHaveLength(2)
        expect(events.every(e => e.commandId === "my-entry-id")).toBe(true)

        await capsule.shutdown()
    })

    it("attributes concurrent runs' activities to their own commandIds", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await Promise.all([
            capsule.run(`axon.activity("note", { text: "from-a" }); await new Promise(r => setTimeout(r, 20)); "a"`),
            capsule.run(`axon.activity("note", { text: "from-b" }); "b"`),
        ])

        const fromA = events.find(e => e.phase === "declared" && e.activity === "note" && e.data.text === "from-a")
        const fromB = events.find(e => e.phase === "declared" && e.activity === "note" && e.data.text === "from-b")
        expect(fromA?.commandId).not.toBe(fromB?.commandId)

        await capsule.shutdown()
    })
})
