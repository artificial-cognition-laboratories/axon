import { AxonBus } from "../../../../src/platform/bus"

describe("AxonBus: emit/on", () => {
    it("calls a registered handler with the emitted payload", async () => {
        const bus = AxonBus()
        const seen: unknown[] = []

        bus.on("custom:event", (payload) => { seen.push(payload) })
        await bus.emit("custom:event", { foo: "bar" })

        expect(seen).toEqual([{ foo: "bar" }])
    })

    it("calls multiple handlers for the same event in registration order", async () => {
        const bus = AxonBus()
        const calls: string[] = []

        bus.on("custom:event", () => { calls.push("first") })
        bus.on("custom:event", () => { calls.push("second") })
        await bus.emit("custom:event", {})

        expect(calls).toEqual(["first", "second"])
    })

    it("does not call handlers registered for a different event", async () => {
        const bus = AxonBus()
        let called = false

        bus.on("other:event", () => { called = true })
        await bus.emit("custom:event", {})

        expect(called).toBe(false)
    })

    it("awaits async handlers before emit() resolves", async () => {
        const bus = AxonBus()
        let done = false

        bus.on("custom:event", async () => {
            await new Promise(resolve => setTimeout(resolve, 5))
            done = true
        })
        await bus.emit("custom:event", {})

        expect(done).toBe(true)
    })

    it("once() only fires a single time", async () => {
        const bus = AxonBus()
        let calls = 0

        bus.once("custom:event", () => { calls++ })
        await bus.emit("custom:event", {})
        await bus.emit("custom:event", {})

        expect(calls).toBe(1)
    })

    it("off() unsubscribes a handler", async () => {
        const bus = AxonBus()
        let calls = 0

        const handler = () => { calls++ }
        bus.on("custom:event", handler)
        bus.off("custom:event", handler)
        await bus.emit("custom:event", {})

        expect(calls).toBe(0)
    })

    it("the unsubscribe function returned by on() removes the handler", async () => {
        const bus = AxonBus()
        let calls = 0

        const unsubscribe = bus.on("custom:event", () => { calls++ })
        unsubscribe()
        await bus.emit("custom:event", {})

        expect(calls).toBe(0)
    })

    it("a throwing handler does not stop later handlers for the same event", async () => {
        const bus = AxonBus()
        const calls: string[] = []

        bus.on("custom:event", () => { throw new Error("boom") })
        bus.on("custom:event", () => { calls.push("second") })
        await bus.emit("custom:event", {})

        expect(calls).toEqual(["second"])
    })
})
