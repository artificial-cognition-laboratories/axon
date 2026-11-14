import { describe, expect, it } from "bun:test"
import { examples } from "@arcforge/body"
import { Body } from "../../src/body"

/** A session that keeps what is committed to it. */
function recorded() {
    const committed: Array<{ type: string; data: unknown }> = []
    return { committed: committed, session: { commit: async (type: string, data: unknown) => { committed.push({ type: type, data: data }) } } as never }
}

describe("kernel body", () => {
    it("wears a body only once it is checked and recorded, and reports it until it leaves", async () => {
        const { committed, session } = recorded()
        const body = Body({ session: session })
        expect(body.current()).toBeNull()
        await body.wear(examples.MINECRAFT)
        expect(body.current()?.kind).toBe("minecraft.player")
        expect(committed.map(event => event.type)).toEqual(["axon:body:worn"])
        await body.leave("its world stopped")
        expect(body.current()).toBeNull()
        expect(committed.at(-1)).toEqual({ type: "axon:body:left", data: { why: "its world stopped" } })
    })

    it("refuses a body that does not describe itself by the contract, and keeps the one it wore", async () => {
        const { committed, session } = recorded()
        const body = Body({ session: session })
        await body.wear(examples.TERRARIA)
        expect(body.wear({ ...examples.TERRARIA, frames: [] })).rejects.toThrow("frames is empty")
        expect(body.current()?.kind).toBe("terraria.player")
        expect(committed).toHaveLength(1)
    })
})

describe("kernel body presence", () => {
    it("says whether the worn body is the mind's to move, records it, and forgets it when the body leaves", async () => {
        const { committed, session } = recorded()
        const body = Body({ session: session })
        expect(body.present({ type: "presence", state: "embodied" })).rejects.toThrow("none is worn")
        await body.wear(examples.ROVER)
        await body.present({ type: "presence", state: "held", why: "night: keeping warm" })
        expect(body.presence()).toEqual({ type: "presence", state: "held", why: "night: keeping warm" })
        expect(committed.at(-1)).toEqual({ type: "axon:body:presence", data: { state: "held", why: "night: keeping warm" } })
        await body.leave("the rover was released")
        expect(body.presence()).toBeNull()
    })
})
