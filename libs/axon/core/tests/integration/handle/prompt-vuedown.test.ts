import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../setup/axon"
import type { AxonTool } from "@arcforge/types"

async function promptDir() {
    return mkdtemp(path.join(tmpdir(), "axon-prompt-vue-test-"))
}

describe("axon.prompt: Vuedown (.vue)", () => {
    it("renders a dynamic .vue prompt to markdown", async () => {
        const dir = await promptDir()
        const filePath = path.join(dir, "hello.vue")
        await writeFile(filePath, `
            <template>
                <h1>Hello</h1>
            </template>
        `)

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "hello", kind: "dynamic", filePath }] },
        })

        const rendered = await runtime.axon.prompt("hello")

        expect(rendered.trim()).toBe("# Hello")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("passes props through to a defineProps() component", async () => {
        const dir = await promptDir()
        const filePath = path.join(dir, "greet.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            const props = defineProps<{ name: string }>()
            </script>
            <template>
                <p>Hello {{ props.name }}</p>
            </template>
        `)

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "greet", kind: "dynamic", filePath }] },
        })

        const rendered = await runtime.axon.prompt("greet", { name: "world" })

        expect(rendered).toContain("Hello world")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("gives <script setup> real access to axon.tools.* — a live capsule call, not a mock", async () => {
        const dir = await promptDir()
        const filePath = path.join(dir, "uses-tool.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            const greeting = await axon.tools.greeter.greet("world")
            </script>
            <template>
                <p>{{ greeting }}</p>
            </template>
        `)

        const greeterTool: AxonTool = {
            name: "greeter",
            origin: "src",
            flat: true,
            fns: [{ name: "greet", declaration: "function greet(name: string): string" }],
            source: `
                export default {
                    name: "greeter",
                    exports: { greet: (name) => "hello " + name },
                }
            `,
        }

        const runtime = await Axon({
            blueprint: {
                tools: [greeterTool],
                prompts: [{ name: "uses-tool", kind: "dynamic", filePath }],
                config: { policy: { tools: { greeter: true } } },
            },
        })

        const rendered = await runtime.axon.prompt("uses-tool")

        expect(rendered).toContain("hello world")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("wraps a malformed SFC as PROMPT_RENDER_FAILED, not a raw vstr Error", async () => {
        // vstr is a generic tool with no @arcforge/err dependency, so it throws
        // a plain Error. The try/catch in render() exists solely to turn that
        // into a structured code — without this test the wrapper could be
        // deleted and every symptom would still look the same in a stack trace,
        // while chat rendered a bare string instead of an AxonError.
        const dir = await promptDir()
        const filePath = path.join(dir, "broken.vue")
        await writeFile(filePath, `<template><p>unclosed`)

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "broken", kind: "dynamic", filePath }] },
        })

        await expect(runtime.axon.prompt("broken")).rejects.toMatchObject({ code: "AX-PROMPT-003" })

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("wraps a throwing <script setup> as PROMPT_RENDER_FAILED", async () => {
        // The other half of the boundary: a well-formed component whose setup
        // throws at render time. Same wrapper, different failure mode — a
        // template that calls a tool that rejects lands here.
        const dir = await promptDir()
        const filePath = path.join(dir, "throws.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            throw new Error("boom from setup")
            </script>
            <template><p>never rendered</p></template>
        `)

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "throws", kind: "dynamic", filePath }] },
        })

        // The underlying vstr error is preserved as `cause` — without it the
        // structured code says "render failed" and nothing says why.
        await expect(runtime.axon.prompt("throws")).rejects.toMatchObject({
            code: "AX-PROMPT-003",
            cause: expect.objectContaining({ message: expect.stringContaining("boom from setup") }),
        })

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("renders with the agent's own env, never the host process's", async () => {
        // promptContext() shims `process` down to { env: blueprint.env } on
        // purpose: a template reaching process.env reads the agent's resolved
        // environment, not whatever is in the shell that launched the TUI.
        // That is a confidentiality boundary, so it is asserted in both
        // directions — the agent's value present, the host's absent.
        const dir = await promptDir()
        const filePath = path.join(dir, "env.vue")
        await writeFile(filePath, `
            <template><p>{{ process.env.AGENT_ONLY }}|{{ process.env.HOST_ONLY ?? "absent" }}</p></template>
        `)

        process.env.HOST_ONLY = "leaked-from-host"
        try {
            const runtime = await Axon({
                blueprint: {
                    env: { AGENT_ONLY: "from-blueprint" },
                    prompts: [{ name: "env", kind: "dynamic", filePath }],
                },
            })

            const rendered = await runtime.axon.prompt("env")

            expect(rendered).toContain("from-blueprint")
            expect(rendered).toContain("absent")
            expect(rendered).not.toContain("leaked-from-host")

            await runtime.shutdown()
        } finally {
            delete process.env.HOST_ONLY
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("re-renders with fresh props on each call — no stale cached output", async () => {
        const dir = await promptDir()
        const filePath = path.join(dir, "echo.vue")
        await writeFile(filePath, `
            <script setup lang="ts">
            const props = defineProps<{ value: string }>()
            </script>
            <template><p>{{ props.value }}</p></template>
        `)

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "echo", kind: "dynamic", filePath }] },
        })

        const first = await runtime.axon.prompt("echo", { value: "one" })
        const second = await runtime.axon.prompt("echo", { value: "two" })

        expect(first).toContain("one")
        expect(second).toContain("two")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })
})
