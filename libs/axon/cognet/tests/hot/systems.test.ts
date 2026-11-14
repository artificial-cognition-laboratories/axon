import type { KernelAbi } from "@arcforge/types"
import { describe, expect, it } from "bun:test"
import { CognetHost } from "../../src/host"
import { Discovered } from "../../src/discovered"
import { component, query } from "../../src/ecs"
import { clock, defineSystem } from "../../src/schedule"
import { Pulse } from "../../src/pulse"

/**
 * A brain made of discovered systems: named by where they are defined, run by
 * the host on every tick, with no loop required.
 */

const ABI = { emit: () => {} } as unknown as KernelAbi
const IDENTITY = { name: "systems", version: "1.0.0", abi: "4", mode: { kind: "invocation" as const } }
const wake = () => ({ stimuli: [], signal: new AbortController().signal })

describe("Discovered", () => {
    it("names definitions from their folder and export, and systems from their path", () => {
        const flow = component<number>()
        const tracked = query({ flow: flow })
        const measure = defineSystem({ writes: [flow], run: () => {} })

        const { systems } = Discovered({
            definitions: [{ file: "L0/vision/components.ts", module: { flow: flow, tracked: tracked }, names: ["flow", "tracked"] }],
            systems: [{ file: "L0/vision/motion/flow.system.ts", module: { default: measure } }],
        })

        expect(flow.name).toBe("L0/vision/flow")
        expect(flow.scope).toBe("L0/vision")
        expect(tracked.name).toBe("L0/vision/tracked")
        expect(systems[0]?.name).toBe("L0/vision/motion/flow")
        expect(systems[0]?.system.writes).toEqual([flow])
    })

    it("resolves named component and query declarations before scheduling", () => {
        const edges = component<number>()
        const corners = component<number>()
        const seen = query({ edges: edges, corners: corners })
        const authored = defineSystem({ on: ["clock"], reads: ["seen"], writes: ["edges"], run: () => {} })
        const { systems } = Discovered({
            definitions: [{ file: "visual/components.ts", module: { edges: edges, corners: corners, seen: seen }, names: ["edges", "corners", "seen"] }],
            systems: [{ file: "visual/shape.system.ts", module: { default: authored } }],
        })
        expect(systems[0]?.system.on).toEqual([clock])
        expect(systems[0]?.system.reads).toEqual([seen])
        expect(systems[0]?.system.writes).toEqual([edges])
    })

    it("rejects unknown names rather than scheduling a partial system", () => {
        const authored = defineSystem({ reads: ["missing"], run: () => {} })
        expect(() => Discovered({ definitions: [], systems: [{ file: "bad.system.ts", module: { default: authored } }] }))
            .toThrow('no component or query is named "missing"')
    })

    it("reserves built-in input names against query declarations", () => {
        const value = component<number>()
        const conflicting = query({ value: value })
        expect(() => Discovered({ definitions: [{ file: "components.ts", module: { clock: conflicting }, names: ["clock"] }], systems: [] }))
            .toThrow("a component or query cannot be called")
    })

    it("rejects clock as a read instead of treating it as data", () => {
        const authored = defineSystem({ reads: ["clock"], run: () => {} })
        expect(() => Discovered({ definitions: [], systems: [{ file: "bad.system.ts", module: { default: authored } }] }))
            .toThrow('"clock" can run a system in on')
    })

    it("scopes a root-level definition to the whole cognet", () => {
        const self = component<number>()
        Discovered({ definitions: [{ file: "components.ts", module: { self: self }, names: ["self"] }], systems: [] })
        expect(self.name).toBe("self")
        expect(self.scope).toBe("")
    })

    it("refuses two definitions with one name in one folder", () => {
        const a = component<number>()
        const b = component<number>()
        expect(() => Discovered({
            definitions: [
                { file: "L0/a.ts", module: { flow: a }, names: ["flow"] },
                { file: "L0/b.ts", module: { flow: b }, names: ["flow"] },
            ],
            systems: [],
        })).toThrow(/"L0\/flow" is defined in both L0\/a.ts and L0\/b.ts/)
    })

    it("refuses a system file without a defineSystem default export", () => {
        expect(() => Discovered({ definitions: [], systems: [{ file: "broken.system.ts", module: { default: {} } }] }))
            .toThrow(/broken.system.ts must `export default defineSystem/)
    })
})

describe("CognetHost with systems", () => {
    function brain(opts: { loop?: boolean } = {}) {
        const ran: string[] = []
        const count = component<number>()
        const echo = component<number>()
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { count: count, echo: echo }, names: ["count", "echo"] }],
            systems: [
                { file: "echo.system.ts", module: { default: defineSystem({ reads: [count], writes: [echo], run: () => { ran.push("echo") } }) } },
                // Counts every tick, so what reads the count runs every tick too.
                { file: "count.system.ts", module: { default: defineSystem({ on: [clock], writes: [count], run: () => {
                    ran.push("count")
                    const world = (globalThis as unknown as { ecs: { component: { get(e: string, c: unknown): number | undefined; set(e: string, c: unknown, v: number): void } } }).ecs
                    world.component.set("self", count, (world.component.get("self", count) ?? 0) + 1)
                } }) } },
            ],
        })
        const host = CognetHost({ ...IDENTITY, systems: systems }, async () => {
            if (!opts.loop) return
            const g = globalThis as unknown as { loop(body: (ctx: { stop(): void }) => Promise<void>): void }
            g.loop(async ({ stop }) => {
                ran.push("loop")
                stop()
            })
        })
        return { host: host, ran: ran }
    }

    it("loads with no loop, and one wake is exactly one tick of systems in data order", async () => {
        const { host, ran } = brain()
        await host.load(ABI)
        await host.wake(wake())
        await host.wake(wake())
        expect(ran).toEqual(["count", "echo", "count", "echo"])
        await host.unload?.()
    })

    it("refuses a mind that declares a loop and has systems — its systems are its program", async () => {
        const { host } = brain({ loop: true })
        await expect(host.load(ABI)).rejects.toMatchObject({ code: "AX-COGNET-017" })
    })

    it("runs a wake given a time at that time: its systems' now, and its world's write times", async () => {
        const seen: number[] = []
        const stamp = component<number>()
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { stamp: stamp }, names: ["stamp"] }],
            systems: [{ file: "stamp.system.ts", module: { default: defineSystem({ on: [clock], writes: [stamp], run: ({ now }) => {
                seen.push(now)
                const world = (globalThis as unknown as { ecs: { component: { set(e: string, c: unknown, v: number): void; writtenAt(e: string, c: unknown): number | undefined } } }).ecs
                world.component.set("self", stamp, now)
                seen.push(world.component.writtenAt("self", stamp)!)
            } }) } }],
        })
        const host = CognetHost({ ...IDENTITY, systems: systems }, async () => {})
        await host.load(ABI)
        await host.wake({ ...wake(), at: 1_000 })
        await host.wake({ ...wake(), at: 1_050 })
        expect(seen).toEqual([1_000, 1_000, 1_050, 1_050])
        await host.unload?.()
    })

    it("refuses a brain with neither a loop nor a system", async () => {
        const host = CognetHost(IDENTITY, async () => {})
        await expect(host.load(ABI)).rejects.toMatchObject({ code: "AX-COGNET-004" })
    })
})

describe("a continuous mind's clock", () => {
    it("wakes the kernel at mode.hz from boot, and stops at unload", async () => {
        let wakes = 0
        const abi = { emit: () => {}, wake: async () => { wakes++; return wakes } } as unknown as KernelAbi
        const host = CognetHost({ ...IDENTITY, mode: { kind: "continuous", hz: 200 } }, async () => {
            ;(globalThis as unknown as { loop(body: (ctx: { stop(): void }) => Promise<void>): void }).loop(async ({ stop }) => stop())
        })
        await host.load(abi)
        await new Promise(resolve => setTimeout(resolve, 60))
        await host.unload?.()
        const atUnload = wakes
        await new Promise(resolve => setTimeout(resolve, 30))

        expect(atUnload).toBeGreaterThan(3)
        expect(wakes).toBe(atUnload)
    })

    it("refuses a load whose rate is not a positive number", async () => {
        const host = CognetHost({ ...IDENTITY, mode: { kind: "continuous", hz: 0 } }, async () => {
            ;(globalThis as unknown as { loop(body: () => Promise<void>): void }).loop(async () => {})
        })
        await expect(host.load(ABI)).rejects.toMatchObject({ code: "AX-COGNET-009" })
    })

    it("reports a refused wake once and stops, rather than every tick", async () => {
        const refusals: unknown[] = []
        const pulse = Pulse({ hz: 500, wake: () => { throw new Error("no cognet") }, refused: cause => refusals.push(cause) })
        pulse.start()
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(refusals).toHaveLength(1)
    })
})

describe("CognetHost with async systems", () => {
    function thinker(mode: { kind: "invocation" } | { kind: "continuous"; hz: number }) {
        const heard: Array<number | undefined> = []
        let release!: () => void
        const slow = new Promise<void>(resolve => { release = resolve })
        const answer = component<number>()
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { answer: answer }, names: ["answer"] }],
            systems: [
                {
                    file: "think.system.ts",
                    module: { default: defineSystem({ once: true, writes: [answer], async run() {
                        await slow
                        ;(globalThis as unknown as { ecs: { component: { set(e: string, c: unknown, v: number): void } } }).ecs.component.set("self", answer, 42)
                    } }) },
                },
                {
                    file: "hear.system.ts",
                    module: { default: defineSystem({ reads: [answer], run() {
                        heard.push((globalThis as unknown as { ecs: { component: { get(e: string, c: unknown): number | undefined } } }).ecs.component.get("self", answer))
                    } }) },
                },
            ],
        })
        const host = CognetHost({ ...IDENTITY, mode: mode, systems: systems }, async () => {})
        return { host: host, heard: heard, release: release }
    }

    it("an invocation wake keeps ticking until its async work lands and is read — then returns", async () => {
        const { host, heard, release } = thinker({ kind: "invocation" })
        await host.load(ABI)
        const woken = host.wake(wake())
        await new Promise(resolve => setTimeout(resolve, 5))
        expect(heard).toEqual([undefined])

        release()
        await woken
        // One wake: the first tick heard nothing, the tick after landing heard the answer.
        expect(heard).toEqual([undefined, 42])
        await host.unload?.()
    })

    it("a continuous wake returns only once the async work it started has settled", async () => {
        const abi = { emit: () => {}, wake: async () => 0 } as unknown as KernelAbi
        const { host, release } = thinker({ kind: "continuous", hz: 1 })
        await host.load(abi)
        let returned = false
        const woken = host.wake(wake()).then(() => { returned = true })
        await new Promise(resolve => setTimeout(resolve, 5))
        expect(returned).toBe(false)

        release()
        await woken
        expect(returned).toBe(true)
        await host.unload?.()
    })
})
