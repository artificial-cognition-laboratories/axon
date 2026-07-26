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
