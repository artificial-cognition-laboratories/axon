import type { KernelAbi } from "@arcforge/types"
import { describe, expect, it } from "bun:test"
import { CognetHost } from "../../src/host"
import { Discovered } from "../../src/discovered"
import { component } from "../../src/ecs"
import { defineSystem } from "../../src/schedule"
import { Effects } from "../../src/effects"

/**
 * A sync run's effects — output, emit, fault — land with its writes: made in
 * order once the run has finished and its writes are in the world, inside the
 * run's own bracket, so one that fails fails the tick. An async run's effects
 * leave as it makes them. The same rule in every language.
 */

declare const kernel: KernelAbi

const IDENTITY = { name: "effects", version: "1.0.0", abi: "4", mode: { kind: "invocation" as const } }
const wake = () => ({ stimuli: [], signal: new AbortController().signal })

function abi(log: string[], opts: { fail?: boolean } = {}) {
    return {
        emit: () => {},
        output: async (_type: string, data: { content: string }) => {
            if (opts.fail) throw new Error("the body refused")
            log.push(`output ${data.content}`)
        },
    } as unknown as KernelAbi
}

function brain(run: () => void | Promise<void>, when: { on: ["clock"] } | { once: true } = { on: ["clock"] }) {
    const said = component<number>()
    const { systems } = Discovered({
        definitions: [{ file: "components.ts", module: { said: said }, names: ["said"] }],
        systems: [{ file: "talk.system.ts", module: { default: defineSystem({ ...when, writes: [said], run: run }) } }],
    })
    return CognetHost({ ...IDENTITY, systems: systems }, async () => {})
}

describe("effects", () => {
    it("lands a sync run's outputs after it finishes, in the order it made them", async () => {
        const log: string[] = []
        const host = brain(() => {
            void kernel.output("cognet:output:text", { channel: "/chat", content: "one" } as never)
            log.push("ran on")
            void kernel.output("cognet:output:text", { channel: "/chat", content: "two" } as never)
        })
        await host.load(abi(log))
        await host.wake(wake())
        await host.unload?.()
        expect(log).toEqual(["ran on", "output one", "output two"])
    })

    it("fails the tick when an output it held fails", async () => {
        const host = brain(() => {
            void kernel.output("cognet:output:text", { channel: "/chat", content: "one" } as never)
        })
        await host.load(abi([], { fail: true }))
        await expect(host.wake(wake())).rejects.toThrow("the body refused")
        await host.unload?.()
    })

    it("sends an async run's outputs as it makes them", async () => {
        const log: string[] = []
        const host = brain(async () => {
            await kernel.output("cognet:output:text", { channel: "/chat", content: "one" } as never)
            log.push("ran on")
        }, { once: true })
        await host.load(abi(log))
        await host.wake(wake())
        await host.unload?.()
        expect(log).toEqual(["output one", "ran on"])
    })

    it("refuses an effect sent from a promise a sync run left behind", async () => {
        const effects = Effects()
        let late: Promise<void> | null = null
        const { effects: held } = effects.hold(() => {
            // Continues after the run returns, still carrying its hold.
            late = Promise.resolve().then(() => effects.send(() => {}))
        })
        expect(held).toEqual([])
        await expect(late!).rejects.toThrow(/after the run had finished/)
    })
})
