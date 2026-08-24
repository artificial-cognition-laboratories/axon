import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../../setup/axon"
import type { AxonEngineDef, AxonEngineRawEvent } from "@arcforge/types"

async function bootDir() {
    return mkdtemp(path.join(tmpdir(), "axon-boot-vue-test-"))
}

/** Captures the system messages the engine actually received — proves what boot.vue rendered into. */
function capturingEngine() {
    const seen: string[][] = []
    const def: AxonEngineDef = {
        name: "capture",
        create: () => ({
            async *stream(req): AsyncGenerator<AxonEngineRawEvent> {
                seen.push(req.messages.filter(m => m.role === "system").map(m => m.content))
                // Real drivers feed their text through as deltas so the AIR
                // parser actually sees the <done/> tag — a raw "done" event
                // alone never reaches the parser, so the loop would never
                // see the model's stop signal.
                const text = "<text>ok</text><done/>"
                yield { type: "text:delta", content: text }
                yield {
                    type: "done",
                    response: {
                        text,
                        stopReason: "end",
                        meta: { provider: "capture", model: "capture", tokens: { in: 0, out: 0, total: 0 }, durationMs: 0 },
                    },
                }
            },
        }),
    }
    return { def, seen }
}

describe("kernel boot: Vuedown (boot.vue)", () => {
    it("renders boot.vue and includes it in the system context sent to the engine", async () => {
        const dir = await bootDir()
        const filePath = path.join(dir, "boot.vue")
        await writeFile(filePath, `<template><h1>Barry</h1></template>`)

        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: { bootFilePath: filePath, config: { engine: def } },
        })

        await runtime.axon.request("hi")

        expect(seen[0].some(m => m.includes("Barry"))).toBe(true)

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("gives boot.vue's <script setup> live access to axon.tools.*", async () => {
        const dir = await bootDir()
        const filePath = path.join(dir, "boot.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            const greeting = await axon.tools.greeter.greet("agent")
            </script>
            <template><h1>{{ greeting }}</h1></template>
        `)

        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: {
                bootFilePath: filePath,
                tools: [{
                    name: "greeter",
                    origin: "src",
                    flat: true,
                    fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
                    source: `export default { name: "greeter", exports: { greet: (name) => "hello " + name } }`,
                }],
                config: { engine: def, policy: { tools: { greeter: true } } },
            },
        })

        await runtime.axon.request("hi")

        expect(seen[0].some(m => m.includes("hello agent"))).toBe(true)

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("re-renders on every tick — reflects a value that changes between calls", async () => {
        const dir = await bootDir()
        const filePath = path.join(dir, "boot.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            const value = await axon.tools.counter.read()
            </script>
            <template><h1>{{ value }}</h1></template>
        `)

        // counter lives inside the capsule, incrementing on each real call —
        // if boot only rendered once and cached the string, both ticks would
        // show "1"
        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: {
                bootFilePath: filePath,
                tools: [{
                    name: "counter",
                    origin: "src",
                    flat: true,
                    fns: [{ name: "read", declaration: "function read(): string" }],
                    source: `let n = 0; export default { name: "counter", exports: { read: () => String(++n) } }`,
                }],
                config: { engine: def, policy: { tools: { counter: true } } },
            },
        })

        await runtime.axon.request("first")
        await runtime.axon.request("second")

        expect(seen[0].some(m => m.includes("# 1"))).toBe(true)
        expect(seen[1].some(m => m.includes("# 2"))).toBe(true)

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("a static boot.md still works unchanged — no Vuedown involved", async () => {
        const runtime = await Axon({ blueprint: { boot: "You are a helpful agent." } })
        const { def, seen } = capturingEngine()

        await runtime.update({ config: { engine: def } })
        await runtime.axon.request("hi")

        expect(seen[0].some(m => m.includes("You are a helpful agent."))).toBe(true)

        await runtime.shutdown()
    })

    it("no boot at all — the system context omits a boot section, nothing throws", async () => {
        const { def, seen } = capturingEngine()
        const runtime = await Axon({ blueprint: { config: { engine: def } } })

        await expect(runtime.axon.request("hi")).resolves.toBeDefined()
        expect(seen[0].some(m => m.includes("<system>"))).toBe(true)

        await runtime.shutdown()
    })
})
