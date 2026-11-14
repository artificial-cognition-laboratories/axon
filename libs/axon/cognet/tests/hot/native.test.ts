import type { KernelAbi } from "@arcforge/types"
import { describe, expect, it } from "bun:test"
import { CognetHost } from "../../src/host"
import { Discovered } from "../../src/discovered"
import { component } from "../../src/ecs"
import { clock, defineSystem } from "../../src/schedule"
import { PROTOCOL, type NativeModule, type NativeSnapshot } from "../../src"

/**
 * A native module's systems run as ordinary ones: handed exactly what they
 * declared, their writes landing through the world as any system's do. The
 * module here is the shape `cargo` builds — `declarations()` and `run()` —
 * written in TypeScript, so what is under test is the runtime's side.
 */

const SCOPE = { modules: [], unavailable: [] }
const ABI = { emit: () => {}, body: () => null, presence: () => null, scope: () => SCOPE, engine: Object.assign(() => { throw new Error("no engines here") }, { has: () => false }), services: { state: () => ({}) } } as unknown as KernelAbi
const IDENTITY = { name: "native", version: "1.0.0", abi: "4", mode: { kind: "invocation" as const } }
const wake = () => ({ stimuli: [], signal: new AbortController().signal })

/** A module holding one system, `counter`, which counts on `self` by its declared component, as Rust would. */
function counter(opts: { writes?: string[]; fail?: string } = {}) {
    const seen: NativeSnapshot[] = []
    const module: NativeModule = {
        protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") },
        declarations: () => [["counter", { on: ["clock"], reads: [], recalls: ["count"], writes: opts.writes ?? ["count"], once: false }]],
        run: (_name, json) => {
            const snapshot: NativeSnapshot = JSON.parse(json)
            seen.push(snapshot)
            if (opts.fail) throw new Error(opts.fail)
            const held = snapshot.entries.find(([component, entity]) => component === "count" && entity === "self")
            const count = typeof held?.[2] === "number" ? held[2] : 0
            return { ran: JSON.stringify({ changes: [{ op: "set", entity: "self", component: opts.writes?.[0] ?? "count", data: count + 1 }], effects: [] }), arrays: [] }
        },
    }
    return { module: module, seen: seen }
}

function brain(module: NativeModule) {
    const count = component<number>()
    const other = component<number>()
    const { systems } = Discovered({
        definitions: [{ file: "components.ts", module: { count: count, other: other }, names: ["count", "other"] }],
        systems: [],
        native: module,
    })
    return { host: CognetHost({ ...IDENTITY, systems: systems }, async () => {}), count: count, systems: systems }
}

describe("Native", () => {
    it("makes each of the module's systems an ordinary one, its handles resolved by name", () => {
        const { systems, count } = brain(counter().module)
        expect(systems.map(one => one.name)).toEqual(["counter"])
        expect(systems[0]!.system.recalls).toEqual([count])
        expect(systems[0]!.system.writes).toEqual([count])
    })

    it("hands a run what it declared, and lands what it wrote", async () => {
        const made = counter()
        const { host, count } = brain(made.module)
        await host.load(ABI)
        await host.wake({ ...wake(), at: 1_000 })
        await host.wake({ ...wake(), at: 1_050 })
        await host.wake({ ...wake(), at: 1_100 })
        const world = (globalThis as unknown as { ecs: { component: { get(e: string, c: unknown): number | undefined } } }).ecs
        expect(world.component.get("self", count)).toBe(3)
        // Nothing the first time; then the count it wrote, recalled.
        expect(made.seen.map(snapshot => snapshot.entries)).toEqual([[], [["count", "self", 1]], [["count", "self", 2]]])
        expect(made.seen.map(snapshot => snapshot.now)).toEqual([1_000, 1_050, 1_100])
        await host.unload?.()
    })

    it("fails the run with the module's fault", async () => {
        const { host } = brain(counter({ fail: "counter panicked: on purpose (at src/counter.system.rs:9)" }).module)
        await host.load(ABI)
        await expect(host.wake(wake())).rejects.toThrow("counter panicked: on purpose")
        await host.unload?.()
    })

    it("refuses a write the system did not declare, as any system's", async () => {
        const made = counter()
        const sneaky: NativeModule = { protocol: made.module.protocol, listen: made.module.listen, tell: made.module.tell, declarations: made.module.declarations, run: () => ({ ran: JSON.stringify({ changes: [{ op: "set", entity: "self", component: "other", data: 1 }], effects: [] }), arrays: [] }) }
        const { host } = brain(sneaky)
        await host.load(ABI)
        await expect(host.wake(wake())).rejects.toThrow(/other/)
        await host.unload?.()
    })

    it("refuses a module that does not say what a native module says", () => {
        expect(() => brain({ protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") }, declarations: () => [["counter", { reads: "count" }]], run: () => ({ ran: JSON.stringify({ changes: [], effects: [] }), arrays: [] }) })).toThrow(/no system's declaration/)
    })

    it("hands a typed array over as its bytes, and takes one back as a typed array", async () => {
        const handed: Array<{ json: string; kinds: string[]; bytes: number[] }> = []
        // Doubles every number of the cloud it recalls, as a Rust system would: the block in, a block out.
        const module: NativeModule = {
            protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") },
            declarations: () => [["doubler", { on: ["clock"], reads: [], recalls: ["count"], writes: ["count"], once: false }]],
            run: (_name, json, kinds, arrays) => {
                handed.push({ json: json, kinds: kinds, bytes: arrays.map(one => one.byteLength) })
                const held = arrays[0] ? new Float64Array(arrays[0].buffer, arrays[0].byteOffset, arrays[0].byteLength / 8) : Float64Array.of(1, 2)
                return { ran: JSON.stringify({ changes: [{ op: "set", entity: "self", component: "count", data: { points: { $array: 0 } } }], effects: [] }), arrays: [held.map(value => value * 2)] }
            },
        }
        const { host, count } = brain(module)
        await host.load(ABI)
        await host.wake({ ...wake(), at: 1_000 })
        await host.wake({ ...wake(), at: 1_050 })
        const world = (globalThis as unknown as { ecs: { component: { get(e: string, c: unknown): unknown } } }).ecs
        expect(world.component.get("self", count)).toEqual({ points: Float64Array.of(4, 8) })
        // The second run was handed the first's array as 16 bytes and a marker — never as numbers in the JSON.
        expect(handed[1]).toEqual({ json: JSON.stringify({ now: 1_050, entities: ["self"], entries: [["count", "self", { points: { $array: 0 } }]], reads: ["count"], writes: ["count"], streams: [] }), kinds: ["f64"], bytes: [16] })
        await host.unload?.()
    })

    it("declares what a native system streams and its lag, and hands it every value written since it last ran", async () => {
        const count = component<number>()
        const other = component<number>()
        const streamed: NativeSnapshot["streams"][] = []
        const module: NativeModule = {
            protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") },
            declarations: () => [["integrate", { reads: [], streams: ["count"], recalls: [], writes: ["other"], once: false, lag: 1 }]],
            run: (_name, json) => {
                const snapshot: NativeSnapshot = JSON.parse(json)
                streamed.push(snapshot.streams)
                return { ran: JSON.stringify({ changes: [], effects: [] }), arrays: [] }
            },
        }
        let n = 0
        const ticker = defineSystem({ on: [clock], writes: [count], run: () => {
            const world = (globalThis as unknown as { ecs: { component: { set(e: string, c: unknown, v: number): void } } }).ecs
            world.component.set("self", count, ++n)
        } })
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { count: count, other: other }, names: ["count", "other"] }],
            systems: [{ file: "ticker.system.ts", module: { default: ticker } }],
            native: module,
        })
        const integrate = systems.find(one => one.name === "integrate")!
        expect(integrate.system.streams).toEqual([count])
        expect(integrate.system.lag).toBe(1)

        // A clock of its own, as a lagged mind has; it asks this kernel for a wake, is refused, and stops.
        const host = CognetHost({ ...IDENTITY, mode: { kind: "continuous", hz: 1 }, systems: systems }, async () => {})
        await host.load(ABI)
        for (let tick = 0; tick < 3; tick++) await host.wake({ ...wake(), at: 1_000 + tick * 50 })
        // Each run lands at the start of the next tick, before any system runs — so it is free, and runs again that
        // tick, taking the one reading written since.
        expect(streamed).toEqual([[["count", [["self", 1, 1_000]]]], [["count", [["self", 2, 1_050]]]], [["count", [["self", 3, 1_100]]]]])
        await host.unload?.()
    })

    it("refuses a system that is both a .system.ts and a .system.rs", () => {
        const count = component<number>()
        expect(() => Discovered({
            definitions: [{ file: "components.ts", module: { count: count }, names: ["count"] }],
            systems: [{ file: "counter.system.ts", module: { default: defineSystem({ writes: [count], run: () => {} }) } }],
            native: counter().module,
        })).toThrow(/both a .system.ts and a .system.rs/)
    })

    it("refuses a module built against a different protocol, naming both", () => {
        const stale: NativeModule = { ...counter().module, protocol: () => PROTOCOL + 1 }
        expect(() => brain(stale)).toThrow(`protocol ${PROTOCOL + 1}; this runtime speaks ${PROTOCOL}`)
    })

    it("refuses a module built before the protocol was versioned", () => {
        const { protocol: _, ...old } = counter().module
        expect(() => brain(old as unknown as NativeModule)).toThrow("says no protocol")
    })

    it("fails a run with a structured fault naming the system", async () => {
        const { host } = brain(counter({ fail: "on purpose" }).module)
        await host.load(ABI)
        await expect(host.wake(wake())).rejects.toMatchObject({ code: "AX-COGNET-027" })
        await host.unload?.()
    })

    it("hands a run the components it may read and write, as the crate's Snapshot requires", async () => {
        const made = counter()
        const { host } = brain(made.module)
        await host.load(ABI)
        await host.wake(wake())
        expect(made.seen[0]).toMatchObject({ reads: ["count"], writes: ["count"] })
        await host.unload?.()
    })

    it("refuses an effect that is no kernel verb, or a verb that is not an effect", async () => {
        for (const [verb, why] of [["teleport", "no kernel verb"], ["service", "it is a call"]] as const) {
            const asking: NativeModule = { ...counter().module, run: () => ({ ran: JSON.stringify({ changes: [], effects: [{ verb: verb, args: {} }] }), arrays: [] }) }
            const { host } = brain(asking)
            await host.load(ABI)
            await expect(host.wake(wake())).rejects.toThrow(why)
            await host.unload?.()
        }
    })
})
