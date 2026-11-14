import { describe, expect, it } from "bun:test"
import { examples, wire } from "../../src"

const minecraft = wire.channels(examples.MINECRAFT)
const say = (message: unknown) => JSON.stringify(message)

describe("wire", () => {
    it("takes a manifest and presence before anything else, and nothing else", () => {
        expect(wire.fromBody(say({ type: "manifest", manifest: examples.MINECRAFT }), null).type).toBe("manifest")
        expect(wire.fromBody(say({ type: "presence", state: "embodied" }), null).type).toBe("presence")
        expect(() => wire.fromBody(say({ type: "reading", channel: "/imu", seq: 0, sensed: 0, values: [0, 0, 0, 0, 0, 0] }), null)).toThrow("before the body's manifest")
    })

    it("hears why a body is not the mind's to move", () => {
        expect(wire.fromBody(say({ type: "presence", state: "overridden", why: "the safety driver has the wheel" }), null)).toEqual({ type: "presence", state: "overridden", why: "the safety driver has the wheel" })
        expect(() => wire.fromBody(say({ type: "presence", state: "held" }), null)).toThrow("why is not text")
        expect(() => wire.fromBody(say({ type: "presence", state: "asleep", why: "night" }), null)).toThrow("not one of embodied, held, overridden, detached")
    })

    it("checks a reading against the sense it is on", () => {
        expect(wire.fromBody(say({ type: "reading", channel: "/imu", seq: 1, sensed: 50, values: [0, 0, 9.8, 0, 0, 0] }), minecraft).type).toBe("reading")
        expect(() => wire.fromBody(say({ type: "reading", channel: "/imu", seq: 1, sensed: 50, values: [0, 0, 9.8] }), minecraft)).toThrow("3 values, where 6 are declared")
        expect(() => wire.fromBody(say({ type: "reading", channel: "/smell", seq: 1, sensed: 50, values: [1] }), minecraft)).toThrow("declared no sense on")
        expect(() => wire.fromBody(say({ type: "reading", channel: "/vision", seq: 1, sensed: 50 }), minecraft)).toThrow("no ref to its bytes")
    })

    it("takes a structured reading only as JSON, and carries nothing it did not check", () => {
        const chat = wire.fromBody(say({ type: "reading", channel: "/chat", seq: 1, sensed: 50, text: say({ from: "Steve", text: "hello" }), extra: "smuggled" }), minecraft)
        expect(chat).toEqual({ type: "reading", channel: "/chat", seq: 1, sensed: 50, text: `{"from":"Steve","text":"hello"}` })
        expect(() => wire.fromBody(say({ type: "reading", channel: "/chat", seq: 1, sensed: 50, text: "hello" }), minecraft)).toThrow("whose text is not JSON")
    })

    it("hears what a command actually did", () => {
        expect(wire.fromBody(say({ type: "applied", channel: "/look", seq: 3, sensed: 100, values: [Math.PI, 0] }), minecraft)).toEqual({ type: "applied", channel: "/look", seq: 3, sensed: 100, values: [Math.PI, 0] })
        expect(() => wire.fromBody(say({ type: "applied", channel: "/look", seq: 3, sensed: 100 }), minecraft)).toThrow("no values, where 2 are declared")
        expect(wire.fromBody(say({ type: "applied", channel: "/say", seq: 4, sensed: 100 }), minecraft).type).toBe("applied")
    })

    it("checks a command against the control it is for", () => {
        expect(wire.toBody(say({ type: "command", channel: "/look", seq: 3, values: [0.5, -0.2], basis: 50 }), minecraft).type).toBe("command")
        expect(() => wire.toBody(say({ type: "command", channel: "/look", seq: 3, values: [0.5] }), minecraft)).toThrow("1 values, where 2 are declared")
        expect(() => wire.toBody(say({ type: "command", channel: "/wings", seq: 3, values: [1] }), minecraft)).toThrow("declared no control on")
        expect(wire.toBody(say({ type: "command", channel: "/say", seq: 4, text: "hi" }), minecraft).type).toBe("command")
    })

    it("takes a plan ahead only where a control takes one, in time order and within its length", () => {
        const rover = wire.channels(examples.ROVER)
        const plan = [{ at: 1_000, values: [0.04, 0] }, { at: 61_000, values: [0.04, 0.05] }, { at: 91_000, values: [0, 0] }]
        expect(wire.toBody(say({ type: "command", channel: "/drive", seq: 1, trajectory: plan }), rover)).toEqual({ type: "command", channel: "/drive", seq: 1, trajectory: plan })
        expect(() => wire.toBody(say({ type: "command", channel: "/drive", seq: 1, trajectory: [plan[1], plan[0]] }), rover)).toThrow("is not after the one before")
        expect(() => wire.toBody(say({ type: "command", channel: "/drive", seq: 1, trajectory: Array.from({ length: 513 }, (_, at) => ({ at: at, values: [0, 0] })) }), rover)).toThrow("at most 512")
        expect(() => wire.toBody(say({ type: "command", channel: "/look", seq: 1, trajectory: plan }), minecraft)).toThrow("which takes none")
        expect(wire.fromBody(say({ type: "applied", channel: "/drive", seq: 1, point: 2, sensed: 91_000, values: [0, 0] }), rover).type).toBe("applied")
        expect(() => wire.fromBody(say({ type: "applied", channel: "/look", seq: 1, point: 2, sensed: 9, values: [0, 0] }), minecraft)).toThrow("takes no trajectories")
    })

    it("steps only a body that waits to be stepped", () => {
        const creature = wire.channels(examples.CREATURE)
        expect(wire.toBody(say({ type: "step", steps: 5 }), creature)).toEqual({ type: "step", steps: 5 })
        expect(wire.fromBody(say({ type: "waiting", sensed: 50 }), creature)).toEqual({ type: "waiting", sensed: 50 })
        expect(() => wire.toBody(say({ type: "step", steps: 0 }), creature)).toThrow("steps is 0")
        expect(() => wire.toBody(say({ type: "step", steps: 1 }), minecraft)).toThrow("whose pace is not stepped")
        expect(() => wire.fromBody(say({ type: "waiting", sensed: 50 }), minecraft)).toThrow("whose pace is not stepped")
    })

    it("refuses what is not a message at all", () => {
        expect(() => wire.fromBody("not json", minecraft)).toThrow("not JSON")
        expect(() => wire.fromBody(say({ channel: "/imu" }), minecraft)).toThrow("no type")
    })
})
