import { describe, expect, it } from "bun:test"
import { State } from "../../../src/ecs/state"
import { Known } from "../../../src/threads/known"
import { Mirror } from "../../../src/threads/mirror"
import type { Job } from "../../../src/threads/wire"
import { named, world } from "../support/world"

/**
 * What crosses to a worker: only what it does not already hold. These pin the
 * bookkeeping that makes a recalled map cross once rather than every tick —
 * and that a worker never computes on a value the world has replaced.
 */

const map = named<Float32Array>("map")
const pose = named<number>("pose")

function job(known: ReturnType<typeof Known>, live: ReturnType<typeof world>, confirmed: Job["confirmed"] = []): Job {
    return { kind: "job", id: 1, system: "s", now: 0, entities: [...live.ecs.state.entities], ...known.delta(live.ecs.state, ["map", "pose"]), streams: [], confirmed: confirmed }
}

describe("Known and Mirror", () => {
    it("send a value once, and again only when the world replaces it", () => {
        const live = world()
        const known = Known()
        live.ecs.component.set("self", map, new Float32Array(4))
        live.ecs.component.set("self", pose, 1)

        expect(job(known, live).entries.map(entry => entry[0])).toEqual(["map", "pose"])
        expect(job(known, live).entries).toEqual([])

        live.ecs.component.set("self", pose, 2)
        expect(job(known, live).entries.map(entry => [entry[0], entry[2]])).toEqual([["pose", 2]])
    })

    it("say what the world dropped", () => {
        const live = world()
        const known = Known()
        live.ecs.component.set("self", pose, 1)
        job(known, live)
        live.ecs.component.remove("self", pose)
        expect(job(known, live).gone).toEqual([["pose", "self"]])
    })

    it("keep a worker's own write on the worker once the world confirms it", () => {
        const live = world()
        const known = Known()
        const copy = State({ stamp: () => ({ tick: 0, phase: null, system: null }), now: () => 0 })
        const mirror = Mirror({ state: copy })
        mirror.sync(job(known, live))

        // The worker writes the map; the world commits it.
        const written = new Float32Array([1, 2, 3])
        const changes = [{ op: "set" as const, entity: "self", component: "map", data: written }]
        mirror.keep([{ op: "set", entity: "self", component: map, data: written }], 5)
        known.forget(changes)
        live.ecs.component.set("self", map, written)
        const confirmed = known.confirm(live.ecs.state, changes)

        const next = job(known, live, confirmed)
        expect(next.entries).toEqual([])
        mirror.sync(next)
        const held = copy.components.get("map")!.get("self")!
        const truth = live.ecs.state.components.get("map")!.get("self")!
        expect(held.rev).toBe(truth.rev)
        expect(held.at).toBe(truth.at)
    })

    it("resend what a worker wrote when its result was discarded", () => {
        const live = world()
        const known = Known()
        live.ecs.component.set("self", pose, 1)
        job(known, live)
        known.forget([{ op: "set", entity: "self", component: "pose", data: 9 }])
        // Never committed: the world still says 1, and the worker must be told so.
        expect(job(known, live).entries.map(entry => entry[2])).toEqual([1])
    })

    it("send the world's value to a job sent before a worker's own write lands, and confirm nothing of it", () => {
        const live = world()
        const known = Known()
        const copy = State({ stamp: () => ({ tick: 0, phase: null, system: null }), now: () => 0 })
        const mirror = Mirror({ state: copy })
        live.ecs.component.set("self", pose, 1)
        mirror.sync(job(known, live))

        // The worker writes 9 and replies; a lagged result, it lands ticks later.
        const changes = [{ op: "set" as const, entity: "self", component: "pose", data: 9 }]
        mirror.keep([{ op: "set", entity: "self", component: pose, data: 9 }], 5)
        known.forget(changes)

        // Meanwhile another job on that worker reads pose: the world still says 1.
        const meanwhile = job(known, live)
        expect(meanwhile.entries.map(entry => entry[2])).toEqual([1])
        mirror.sync(meanwhile)

        // The write lands. The worker holds 1, not 9: nothing is confirmed, and 9 is sent when next read.
        live.ecs.component.set("self", pose, 9)
        expect(known.confirm(live.ecs.state, changes)).toEqual([])
        const next = job(known, live)
        expect(next.entries.map(entry => entry[2])).toEqual([9])
        mirror.sync(next)
        expect(copy.components.get("pose")!.get("self")!.data).toBe(9)
    })
})
