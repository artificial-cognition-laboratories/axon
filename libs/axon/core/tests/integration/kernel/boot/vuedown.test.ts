import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon, driver } from "../../../setup/axon"
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
                // parser actually sees the  tag — a raw "done" event
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
            blueprint: { bootFilePath: filePath, config: { providers: [driver(def)] } },
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
                config: { providers: [driver(def)], policy: { tools: { greeter: true } } },
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
                config: { providers: [driver(def)], policy: { tools: { counter: true } } },
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
        // Declared at BOOT rather than swapped in by update(): inference
        // resolves once, from the user's providers, and a config reload no
        // longer re-binds it.
        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: { boot: "You are a helpful agent.", config: { providers: [driver(def)] } },
        })

        await runtime.axon.request("hi")

        expect(seen[0].some(m => m.includes("You are a helpful agent."))).toBe(true)

        await runtime.shutdown()
    })

    it("no boot at all — the system context omits a boot section, nothing throws", async () => {
        const { def, seen } = capturingEngine()
        const runtime = await Axon({ blueprint: { config: { providers: [driver(def)] } } })

        await expect(runtime.axon.request("hi")).resolves.toBeDefined()
        expect(seen[0].some(m => m.includes("<system"))).toBe(true)

        await runtime.shutdown()
    })

    /**
     * A boot.vue that will not render must never stop the agent replying.
     *
     * render() is called by kernel.base() on EVERY tick, inside the cognet's
     * render phase — so a throw there does not merely fail the boot, it kills
     * the wake. Saving a typo mid-session stopped the agent answering at all,
     * while the user was editing the very file they would use it to fix.
     *
     * Nothing about the degradation is silent: the model is told which of the
     * two situations it is in, because they call for different behaviour.
     */
    it("a broken boot.vue keeps the last render that worked", async () => {
        const dir = await bootDir()
        const filePath = path.join(dir, "boot.vue")
        await writeFile(filePath, `<template><h1>Barry</h1></template>`)

        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: { bootFilePath: filePath, config: { providers: [driver(def)] } },
        })

        await runtime.axon.request("hi")
        expect(seen[0].some(m => m.includes("Barry"))).toBe(true)

        // Broken mid-session, exactly as a save would.
        await writeFile(filePath, `<text><h1>Barry</h1>{{ unclosed`)
        await runtime.axon.request("still there?")

        const latest = seen[seen.length - 1].join("\n")
        // Identity survives — stale instructions are far better than none.
        expect(latest).toContain("Barry")
        // And the model is told they may be out of date.
        expect(latest).toContain("last version that worked")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("a boot.vue broken before it ever rendered tells the model it has no identity", async () => {
        const dir = await bootDir()
        const filePath = path.join(dir, "boot.vue")
        await writeFile(filePath, `<text>{{ never closed`)

        const { def, seen } = capturingEngine()
        const runtime = await Axon({
            blueprint: { bootFilePath: filePath, config: { providers: [driver(def)] } },
        })

        // Replies at all — this is the property the change exists for.
        await runtime.axon.request("who are you?")

        // With nothing to fall back to, empty context would make it answer
        // confidently as a generic assistant and the user could not tell why
        // it stopped sounding like theirs.
        expect(seen[0].join("\n")).toContain("running without the identity")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })
})
