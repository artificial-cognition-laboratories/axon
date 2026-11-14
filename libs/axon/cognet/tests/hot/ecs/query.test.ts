import { describe, expect, it } from "bun:test"
import { named, world } from "../support/world"

/** What the compile step would generate: every full name, and each export name only one component has. */
type Components = {
    "body/place": { x: number; zone: string }
    place: { x: number; zone: string }
    "body/travel": { dx: number }
    travel: { dx: number }
    "body/support": "ground" | "air"
    support: "ground" | "air"
    "map/usual": number
    "look/usual": number
}

named<Components["place"]>("body/place")
named<Components["travel"]>("body/travel")
named<Components["support"]>("body/support")
named<number>("map/usual")
named<number>("look/usual")

describe("Ecs: queries", () => {
    it("returns one object per entity holding every component, keyed by export name", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "b", components: { "place": { x: 2, zone: "cave" } } })
        ecs.set({ id: "b", components: { "travel": { dx: 1 } } })
        ecs.set({ id: "a", components: { "body/place": { x: 1, zone: "sky" } } })
        ecs.set({ id: "a", components: { "travel": { dx: 0 } } })
        ecs.set({ id: "c", components: { "place": { x: 3, zone: "sky" } } })

        expect(ecs.query({ components: ["place", "body/travel"] })).toEqual([
            { id: "a", meta: expect.anything(), place: { x: 1, zone: "sky" }, travel: { dx: 0 } },
            { id: "b", meta: expect.anything(), place: { x: 2, zone: "cave" }, travel: { dx: 1 } },
        ])
    })

    it("is empty when a component has never been written, so one row destructures to undefined", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { "place": { x: 1, zone: "sky" } } })
        const [row] = ecs.query({ components: ["place", "travel"] })
        expect(row).toBeUndefined()
    })

    it("keeps rows whose values equal `where` — a whole value, or the fields given", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { "place": { x: 1, zone: "sky" } } })
        ecs.set({ id: "a", components: { "support": "ground" } })
        ecs.set({ id: "b", components: { "place": { x: 2, zone: "cave" } } })
        ecs.set({ id: "b", components: { "support": "air" } })

        expect(ecs.query({ components: ["support"], where: { support: "ground" } }).map(row => row.id)).toEqual(["a"])
        expect(ecs.query({ components: ["place"], where: { place: { zone: "cave" } } }).map(row => row.id)).toEqual(["b"])
    })

    it("keeps rows passing `filter`, after `where`", () => {
        const { ecs } = world<Components>()
        for (const [id, x] of [["a", 1], ["b", 2], ["c", 3]] as const) ecs.set({ id: id, components: { "place": { x: x, zone: "sky" } } })
        const far = ecs.query({ components: ["place"], where: { place: { zone: "sky" } }, filter: row => row.place.x > 1 })
        expect(far.map(row => row.id)).toEqual(["b", "c"])
    })

    it("sets what has a value, removes what is null, and leaves alone what is undefined", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" }, travel: { dx: 0 }, support: "ground" } })
        ecs.set({ id: "a", components: { place: { x: 2, zone: "sky" }, travel: null, support: undefined } })

        expect(ecs.query({ components: ["travel"] })).toEqual([])
        const [row] = ecs.query({ components: ["place", "support"] })
        expect(row?.place.x).toBe(2)
        expect(row?.support).toBe("ground")
    })

    it("writes several entities in one call", () => {
        const { ecs } = world<Components>()
        ecs.set([
            { id: "a", components: { support: "ground" } },
            { id: "b", components: { support: "air" } },
        ])
        expect(ecs.query({ components: ["support"] }).map(row => row.id)).toEqual(["a", "b"])
    })

    it("says when each component was written, and which change it is", () => {
        let now = 1000
        const { ecs } = world<Components>({ now: () => now })
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" } } })
        now = 1500
        ecs.set({ id: "a", components: { travel: { dx: 0 } } })
        const [first] = ecs.query({ components: ["place", "travel"] })
        expect(first?.meta.place.at).toBe(1000)
        expect(first?.meta.travel.at).toBe(1500)

        now = 2000
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" } } })
        const [again] = ecs.query({ components: ["place"] })
        expect(again?.meta.place).toEqual({ at: 2000, rev: first!.meta.place.rev })
    })

    it("reads optional components from the same entity, undefined where it holds none", () => {
        let now = 1000
        const { ecs } = world<Components>({ now: () => now })
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" }, travel: { dx: 3 } } })
        ecs.set({ id: "b", components: { place: { x: 2, zone: "sky" } } })
        ecs.set({ id: "c", components: { travel: { dx: 9 } } })

        const rows = ecs.query({ components: ["place"], optional: ["travel", "support"] })
        expect(rows.map(row => [row.id, row.travel?.dx, row.support, row.meta.travel?.at])).toEqual([
            ["a", 3, undefined, 1000],
            ["b", undefined, undefined, undefined],
        ])
        expect(ecs.query({ components: ["place"], optional: ["travel"], where: { travel: { dx: 3 } } }).map(row => row.id)).toEqual(["a"])
    })

    it("refuses a name nothing has, and a short name two components share", () => {
        const { ecs } = world()
        expect(() => ecs.query({ components: ["nowhere"] })).toThrow(/no component is named "nowhere"/)
        expect(() => ecs.query({ components: ["usual"] })).toThrow(/look\/usual and map\/usual|map\/usual and look\/usual/)
        expect(() => ecs.query({ components: ["map/usual", "look/usual"] })).toThrow(/called the same/)
    })

    it("records every component of every returned row as read", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { "place": { x: 1, zone: "sky" } } })
        ecs.set({ id: "a", components: { "travel": { dx: 0 } } })
        const { reads } = ecs.observe(() => ecs.query({ components: ["place", "travel"] }))
        expect(reads.map(read => read.component).sort()).toEqual(["body/place", "body/travel"])
    })

    it("records query matches, optional absence, filtering and empty results by revision", () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" }, travel: { dx: 2 } } })
        ecs.set({ id: "b", components: { place: { x: 3, zone: "cave" } } })
        const observed = ecs.observe(() => {
            ecs.query({ components: ["place"], optional: ["travel"], filter: row => row.place.x > 1 })
            ecs.query({ components: ["support"] })
        })
        expect(observed.queries).toEqual([
            { ordinal: 0, required: ["body/place"], optional: ["body/travel"], filtered: true, candidates: 2, count: 1, matched: [{ entity: "b", values: [{ entity: "b", component: "body/place", rev: expect.any(Number) }] }] },
            { ordinal: 1, required: ["body/support"], optional: [], filtered: false, candidates: 0, count: 0, matched: [] },
        ])
    })

    it("keeps an isolated async run's query observations across awaits", async () => {
        const { ecs } = world<Components>()
        ecs.set({ id: "a", components: { place: { x: 1, zone: "sky" } } })
        const isolation = ecs.isolate({ system: "reader", reads: new Set(["body/place"]), writes: new Set<string>() })
        const observed = await isolation.observeAsync(() => isolation.run(async () => {
            await Promise.resolve()
            ecs.query({ components: ["place"] })
        }))
        expect(observed.queries[0]).toMatchObject({ count: 1, matched: [{ entity: "a" }] })
        expect(observed.reads).toHaveLength(1)
    })
})
