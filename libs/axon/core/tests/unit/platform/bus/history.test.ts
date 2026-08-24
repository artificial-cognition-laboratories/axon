import { AxonBus } from "../../../../src/platform/bus"

describe("AxonBus: history, onAny, forward", () => {
    it("records every emitted event in order", async () => {
        const bus = AxonBus()

        await bus.emit("first", { n: 1 })
        await bus.emit("second", { n: 2 })

        expect(bus.history().map(e => e.event)).toEqual(["first", "second"])
    })

    it("filters history by event name", async () => {
        const bus = AxonBus()

        await bus.emit("first", { n: 1 })
        await bus.emit("second", { n: 2 })
        await bus.emit("first", { n: 3 })

        expect(bus.history({ event: "first" }).map(e => e.payload)).toEqual([{ n: 1 }, { n: 3 }])
    })

    it("limits history to the last N entries", async () => {
        const bus = AxonBus()

        await bus.emit("a", {})
        await bus.emit("b", {})
        await bus.emit("c", {})

        expect(bus.history({ limit: 2 }).map(e => e.event)).toEqual(["b", "c"])
    })

    it("clearHistory() empties the buffer", async () => {
        const bus = AxonBus()

        await bus.emit("a", {})
        bus.clearHistory()

        expect(bus.history()).toEqual([])
    })

    it("onAny() sees every event regardless of name", async () => {
        const bus = AxonBus()
        const seen: string[] = []

        bus.onAny((event) => { seen.push(event) })
        await bus.emit("a", {})
        await bus.emit("b", {})

        expect(seen).toEqual(["a", "b"])
    })

    it("forward() emits under the payload's own type field", async () => {
        const bus = AxonBus()
        const seen: unknown[] = []

        bus.on("external:thing", (payload) => { seen.push(payload) })
        await bus.forward({ type: "external:thing", data: 42 })

        expect(seen).toEqual([{ type: "external:thing", data: 42 }])
    })

    it("caps history at maxHistory, dropping the oldest entries", async () => {
        const bus = AxonBus({ maxHistory: 2 })

        await bus.emit("a", {})
        await bus.emit("b", {})
        await bus.emit("c", {})

        expect(bus.history().map(e => e.event)).toEqual(["b", "c"])
    })
})
