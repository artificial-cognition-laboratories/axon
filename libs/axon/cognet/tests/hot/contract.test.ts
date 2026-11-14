import type { KernelAbi } from "@arcforge/types"
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CognetHost } from "../../src/host"
import { Discovered } from "../../src/discovered"
import { component } from "../../src/ecs"
import { PROTOCOL, type NativeModule } from "../../src"
import { answered, surface } from "../../src/verbs"
import { Conversation, type Told } from "../../src/conversation"

/**
 * The run protocol, pinned on both sides by one file. This test proves the
 * runtime SENDS exactly `tests/contract/snapshot.json`; the `cognet` crate's
 * `tests/contract.rs` proves Rust READS it. A field one side adds or drops
 * fails one of the two — never every run of every Rust system, silently.
 */

const SCOPE = { modules: [], unavailable: [] }
const PRESENCE = { state: "embodied" }
const SERVICES = { depth: { available: true, describe: { maxSide: 518 } }, hear: { available: false, describe: null } }
const ABI = { emit: () => {}, body: () => null, presence: () => PRESENCE, scope: () => SCOPE, engine: Object.assign(() => { throw new Error("no engines here") }, { has: () => false }), services: { state: () => SERVICES } } as unknown as KernelAbi
const IDENTITY = { name: "contract", version: "1.0.0", abi: "4", mode: { kind: "invocation" as const } }
const FIXTURE = join(import.meta.dir, "..", "contract", "snapshot.json")
const RAN = join(import.meta.dir, "..", "contract", "ran.json")

describe("run protocol", () => {
    it("sends the snapshot the crate is pinned to read", async () => {
        const sent: string[] = []
        const module: NativeModule = {
            protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") },
            declarations: () => [["counter", { on: ["clock"], reads: [], recalls: ["count"], writes: ["count"], once: false }]],
            run: (_name, json) => {
                sent.push(json)
                return { ran: JSON.stringify({ changes: [], effects: [] }), arrays: [] }
            },
        }
        const count = component<{ at: number; points: Float64Array }>()
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { count: count }, names: ["count"] }],
            systems: [],
            native: module,
        })
        const host = CognetHost({ ...IDENTITY, systems: systems }, async () => {})
        await host.load(ABI)
        const world = (globalThis as unknown as { ecs: { set(write: unknown): void } }).ecs
        world.set({ id: "self", components: { count: { at: 12, points: Float64Array.of(1, 2) } } })
        await host.wake({ stimuli: [], signal: new AbortController().signal, at: 1_000 })
        await host.unload?.()

        expect(JSON.parse(sent[0]!)).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")))
    })

    it("lands the reply the crate is pinned to write: its changes, then its effects", async () => {
        const outputs: unknown[] = []
        const kernel = { ...ABI, output: async (type: string, data: unknown) => { outputs.push([type, data]) } } as unknown as KernelAbi
        const module: NativeModule = {
            protocol: () => PROTOCOL, listen: () => {}, tell: () => { throw new Error("this module holds no async system") },
            declarations: () => [["counter", { on: ["clock"], reads: [], recalls: ["count"], writes: ["count"], once: false }]],
            run: () => ({ ran: readFileSync(RAN, "utf8"), arrays: [Float64Array.of(3)] }),
        }
        const count = component<{ at: number; points: Float64Array }>()
        const { systems } = Discovered({
            definitions: [{ file: "components.ts", module: { count: count }, names: ["count"] }],
            systems: [],
            native: module,
        })
        const host = CognetHost({ ...IDENTITY, systems: systems }, async () => {})
        await host.load(kernel)
        await host.wake({ stimuli: [], signal: new AbortController().signal, at: 1_000 })
        const world = (globalThis as unknown as { ecs: { component: { get(e: string, c: unknown): unknown } } }).ecs
        expect(world.component.get("self", count)).toEqual({ at: 13, points: Float64Array.of(3) })
        expect(outputs).toEqual([["cognet:output:vector", { channel: "/wheels", values: [0.4, 0.4], basis: 12 }]])
        await host.unload?.()
    })

    it("pins the kernel's surface every language is held to, and answers every call it lists", () => {
        const pinned = JSON.parse(readFileSync(join(import.meta.dir, "..", "contract", "verbs.json"), "utf8"))
        expect(surface()).toEqual(pinned)
        expect(answered().sort()).toEqual([...pinned.calls].sort())
    })

    it("speaks every message of the conversation as pinned, and hears every one a running system says", async () => {
        const messages = JSON.parse(readFileSync(join(import.meta.dir, "..", "contract", "messages.json"), "utf8"))
        const told: Told[] = []
        const calls: Array<[string, unknown]> = []
        const effects: unknown[] = []
        const conversation = Conversation({ send: one => told.push(one), failing: "COGNET_SYSTEM_FAULT" })
        const streamed: Array<[string, unknown]> = []
        const session = {
            signal: new AbortController().signal,
            call: async (op: string, args: unknown) => { calls.push([op, args]); return [10, 20] },
            async *stream(op: string, args: unknown, signal: AbortSignal) {
                streamed.push([op, args])
                yield { text: "Hel" }
                yield { text: "lo" }
                // A stopped stream is never pulled again.
                await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
                yield { text: "never" }
            },
            effect: async (one: unknown) => { effects.push(one) },
        }
        const job = messages.told.job
        const running = conversation.begin(job.system, job.snapshot, job.kinds, [], session)
        expect(told[0]).toEqual(job)

        conversation.heard(JSON.stringify(messages.said.call))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(calls).toEqual([["service.call", { use: "depth", method: "estimate", args: { picture: [1, 2] } }]])
        expect(Object.keys(told[1]!).sort()).toEqual(Object.keys(messages.told.answer).sort())

        // A streamed call: each answer an event, keyed by the call — until the run stops listening.
        const before = told.length
        conversation.heard(JSON.stringify(messages.said.stream))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(streamed).toEqual([["service.stream", { use: "main", method: "stream", args: { conversation: { messages: [{ role: "user", text: "hi" }] } } }]])
        expect(told.slice(before)).toEqual([messages.told.event, { ...messages.told.event, value: "{\"text\":\"lo\"}" }])
        conversation.heard(JSON.stringify(messages.said.stop))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(told.length).toBe(before + 2)

        conversation.heard(JSON.stringify(messages.said.effect))
        conversation.heard(JSON.stringify(messages.said.done))
        expect(await running).toEqual({ ran: messages.said.done.ran, arrays: [] })
        expect(effects).toEqual([{ verb: "output", args: { type: "text", data: { channel: "/log", content: "asked" } } }])

        for (const ending of ["error", "cancelled"] as const) {
            const failing = conversation.begin(job.system, job.snapshot, [], [], session)
            const id = (told.at(-1) as { job: number }).job
            conversation.heard(JSON.stringify({ ...messages.said[ending], job: id }))
            await expect(failing).rejects.toBeDefined()
        }
    })
})
