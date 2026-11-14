import { describe, expect, test } from "bun:test"
import { from } from "../../../src/pure"
import { testLocus } from "../../locus"

describe("put / get / delete", () => {
    test("a record round-trips with its coordinate and payload", async () => {
        const locus = await testLocus()
        const coord = from(locus.space, { threat: 0.8, noisy: 1 })

        const id = await locus.records.put({ coord: coord, payload: { name: "slime" } })
        const record = await locus.records.get(id)

        expect(record.id).toBe(id)
        expect(record.payload).toEqual({ name: "slime" })
        // 8-bit storage: a value comes back as the nearest of 256 levels, within 1/510.
        expect(record.coord.values[0]).toBeCloseTo(0.8, 2)
    })

    test("quantisation preserves the endpoints exactly — 0 and 1 must not drift", async () => {
        const locus = await testLocus()
        const id = await locus.records.put({ coord: from(locus.space, { threat: 0, fragile: 1 }) })
        const record = await locus.records.get(id)

        // conf = 0 means unmeasured, so a measured value of exactly 0 must round to
        // level 0 and come back as exactly 0 — not as 0.0039.
        expect(record.coord.values[0]).toBe(0)
        expect(record.coord.values[1]).toBe(1)
        expect(record.coord.conf[0]).toBe(1)
    })

    test("an unmeasured axis survives the round trip as unmeasured", async () => {
        const locus = await testLocus()
        const id = await locus.records.put({ coord: from(locus.space, { threat: 0.8 }) })
        const record = await locus.records.get(id)
        expect(record.coord.conf[2]).toBe(0)
    })

    test("a missing id throws rather than returning null", async () => {
        const locus = await testLocus()
        await expect(locus.records.get("nope")).rejects.toThrow(/Record Not Found|nope/)
    })

    test("delete removes it from the index and reports whether it did anything", async () => {
        const locus = await testLocus()
        const id = await locus.records.put({ coord: from(locus.space, { threat: 0.5 }) })

        expect(locus.records.count).toBe(1)
        expect(await locus.records.delete(id)).toBe(true)
        expect(locus.records.count).toBe(0)
        expect(await locus.records.delete(id)).toBe(false)
    })

    test("putting the same id twice replaces rather than duplicating", async () => {
        const locus = await testLocus()
        await locus.records.put({ id: "a", coord: from(locus.space, { threat: 0.1 }) })
        await locus.records.put({ id: "a", coord: from(locus.space, { threat: 0.9 }) })

        expect(locus.records.count).toBe(1)
        expect((await locus.records.get("a")).coord.values[0]).toBeCloseTo(0.9, 2)
    })

    test("a coordinate from another basis is refused at the door", async () => {
        const locus = await testLocus()
        const alien = { space: "deadbeefdeadbeef", values: new Float32Array(5), conf: new Float32Array(5) }
        await expect(locus.records.put({ coord: alien })).rejects.toThrow(/Different Basis|basis/)
    })

    test("growing past the initial capacity keeps every row intact", async () => {
        const locus = await testLocus()
        const ids: string[] = []
        for (let i = 0; i < 1200; i++) {
            ids.push(await locus.records.put({ coord: from(locus.space, { threat: i / 1200 }) }))
        }

        expect(locus.records.count).toBe(1200)
        expect((await locus.records.get(ids[0]!)).coord.values[0]).toBeCloseTo(0, 5)
        expect((await locus.records.get(ids[1199]!)).coord.values[0]).toBeCloseTo(1199 / 1200, 2)
    })
})
