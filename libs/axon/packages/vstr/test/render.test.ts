import { test, expect, describe, beforeEach } from "bun:test"
import { resolve } from "path"
import { vstr } from "../src/index"

const fixture = (name: string) => resolve(import.meta.dir, "fixtures", name)

// ─── Construction ─────────────────────────────────────────────────────────────

describe("vstr — construction", () => {
    test("vstr() is synchronous — returns template without awaiting", () => {
        const tpl = vstr(fixture("basic.vue"))
        expect(tpl).toBeDefined()
        expect(typeof tpl.render).toBe("function")
        expect(typeof tpl.introspect).toBe("function")
    })

    test("vstr.source() is synchronous — returns template without awaiting", () => {
        const tpl = vstr.source(`<template><p>hi</p></template>`)
        expect(tpl).toBeDefined()
        expect(typeof tpl.render).toBe("function")
    })
})

// ─── Basic rendering ──────────────────────────────────────────────────────────

describe("vstr — basic rendering", () => {
    test("renders prop into template", async () => {
        const out = await vstr(fixture("basic.vue")).render({ name: "Cody" })
        expect(out).toContain("Hello Cody")
    })

    test("applies default prop when not provided", async () => {
        const out = await vstr(fixture("basic.vue")).render()
        expect(out).toContain("Hello world")
    })

    test("renders h1 as markdown heading", async () => {
        const out = await vstr(fixture("basic.vue")).render({ name: "X" })
        expect(out).toMatch(/^# Hello X/m)
    })

    test("renders static text alongside props", async () => {
        const out = await vstr(fixture("basic.vue")).render({ name: "Cody" })
        expect(out).toContain("basic test")
    })
})

// ─── Conditional and iteration ────────────────────────────────────────────────

describe("vstr — conditional and iteration", () => {
    test("renders v-if when true", async () => {
        const out = await vstr(fixture("conditional.vue")).render({ show: true, items: [] })
        expect(out).toContain("Visible content")
    })

    test("omits v-if when false", async () => {
        const out = await vstr(fixture("conditional.vue")).render({ show: false, items: [] })
        expect(out).not.toContain("Visible content")
    })

    test("renders v-for list items", async () => {
        const out = await vstr(fixture("conditional.vue")).render({ items: ["alpha", "beta", "gamma"] })
        expect(out).toContain("alpha")
        expect(out).toContain("beta")
        expect(out).toContain("gamma")
    })

    test("renders empty list with no items", async () => {
        const out = await vstr(fixture("conditional.vue")).render({ items: [] })
        expect(out).not.toMatch(/alpha|beta|gamma/)
    })
})

// ─── Code formatting ──────────────────────────────────────────────────────────

describe("vstr — code formatting", () => {
    test("renders inline code with backticks", async () => {
        const out = await vstr(fixture("code.vue"), { noCache: true }).render()
        expect(out).toContain("`fs.read(path)`")
    })

    test("renders pre with data-lang as fenced code block", async () => {
        const out = await vstr(fixture("code.vue"), { noCache: true }).render()
        expect(out).toContain("```typescript")
        expect(out).toContain("const x = 1")
    })

    test("renders plain pre as fenced block without lang", async () => {
        const out = await vstr(fixture("code.vue"), { noCache: true }).render()
        expect(out).toContain("```\nplain block")
    })
})

// ─── Section separators ───────────────────────────────────────────────────────

describe("vstr — section separators", () => {
    test("wraps sections with horizontal rule separators", async () => {
        const out = await vstr(fixture("section.vue"), { noCache: true }).render()
        expect(out).toContain("---")
        expect(out).toContain("Section A")
        expect(out).toContain("Section B")
    })
})

// ─── Template-only (no script) ────────────────────────────────────────────────

describe("vstr — template-only (no script)", () => {
    test("renders template with no script block", async () => {
        const out = await vstr(fixture("no-script.vue"), { noCache: true }).render()
        expect(out).toContain("Static content")
        expect(out).toContain("No script block")
    })
})

// ─── Sub-components ───────────────────────────────────────────────────────────

describe("vstr — sub-components", () => {
    test("renders sub-component imported in script setup", async () => {
        const out = await vstr(fixture("with-component.vue"), { noCache: true }).render()
        expect(out).toContain("Parent content")
        expect(out).toContain("badge:alpha")
    })

    test("renders globally registered component", async () => {
        const out = await vstr(fixture("basic.vue"), {
            noCache: true,
            components: { Badge: fixture("components/badge.vue") },
        }).render({ name: "World" })
        expect(out).toContain("Hello World")
    })
})

// ─── Context injection ────────────────────────────────────────────────────────

describe("vstr — context injection", () => {
    test("injects sync API as global in script setup", async () => {
        const out = await vstr(fixture("context.vue"), {
            noCache: true,
            context: {
                myApi: { hello: (name: string) => `Hi ${name}` },
                myTool: async () => "tool-output",
            },
        }).render()
        expect(out).toContain("Hi world")
        expect(out).toContain("tool-output")
    })

    test("injects async function as global in script setup", async () => {
        const out = await vstr(fixture("context.vue"), {
            noCache: true,
            context: {
                myApi: { hello: (name: string) => `Async hi ${name}` },
                myTool: async () => "async-result",
            },
        }).render()
        expect(out).toContain("async-result")
    })

    test("context does not leak between templates", async () => {
        const tpl1 = vstr(fixture("context.vue"), {
            noCache: true,
            context: {
                myApi: { hello: () => "from-tpl1" },
                myTool: async () => "tpl1-tool",
            },
        })
        const tpl2 = vstr(fixture("context.vue"), {
            noCache: true,
            context: {
                myApi: { hello: () => "from-tpl2" },
                myTool: async () => "tpl2-tool",
            },
        })

        const [out1, out2] = await Promise.all([tpl1.render(), tpl2.render()])

        expect(out1).toContain("from-tpl1")
        expect(out1).not.toContain("from-tpl2")
        expect(out2).toContain("from-tpl2")
        expect(out2).not.toContain("from-tpl1")
    })

    test("context globals are reachable from template expressions", async () => {
        const src = `<template><h1>{{ process.env.NAME }} / {{ api.id }}</h1></template>
<script setup lang="ts"></script>`
        const out = await vstr.source(src, {
            noCache: true,
            context: { process: { env: { NAME: "Steve" } }, api: { id: "ax1" } },
        }).render()
        expect(out).toContain("Steve / ax1")
    })
})

// ─── Output formats ───────────────────────────────────────────────────────────

describe("vstr — output formats", () => {
    test("markdown is the default format", async () => {
        const out = await vstr(fixture("basic.vue")).render({ name: "X" })
        expect(out).toMatch(/^# Hello X/m)
    })

    test("html format returns raw html", async () => {
        const out = await vstr(fixture("basic.vue"), { format: "html", noCache: true }).render({ name: "X" })
        expect(out).toContain("<h1>")
        expect(out).toContain("Hello X")
    })

    test("text format strips all html tags", async () => {
        const out = await vstr(fixture("basic.vue"), { format: "text", noCache: true }).render({ name: "X" })
        expect(out).not.toContain("<")
        expect(out).not.toContain(">")
        expect(out).toContain("Hello X")
    })
})

// ─── vstr.source — inline source string ──────────────────────────────────────

describe("vstr.source — inline source string", () => {
    test("renders a source string directly", async () => {
        const out = await vstr.source(`
<template><h1>Hello {{ name }}</h1></template>
<script setup lang="ts">
const { name } = defineProps<{ name: string }>()
</script>`).render({ name: "inline" })
        expect(out).toContain("Hello inline")
    })

    test("applies default props in inline source", async () => {
        const out = await vstr.source(`
<template><p>{{ msg }}</p></template>
<script setup lang="ts">
const { msg = "default" } = defineProps<{ msg?: string }>()
</script>`).render()
        expect(out).toContain("default")
    })

    test("renders template-only inline source", async () => {
        const out = await vstr.source(`<template><p>static</p></template>`).render()
        expect(out).toContain("static")
    })

    test("supports context injection", async () => {
        const out = await vstr.source(`
<template><p>{{ result }}</p></template>
<script setup lang="ts">
const result = getValue()
</script>`, { context: { getValue: () => "injected" } }).render()
        expect(out).toContain("injected")
    })

    test("supports html format", async () => {
        const out = await vstr.source(`<template><h2>Hi</h2></template>`, { format: "html" }).render()
        expect(out).toContain("<h2>")
    })
})

// ─── Caching ──────────────────────────────────────────────────────────────────

describe("vstr — caching", () => {
    beforeEach(() => {
        vstr.clearCache()
    })

    test("two templates for same path produce identical output", async () => {
        const [out1, out2] = await Promise.all([
            vstr(fixture("basic.vue")).render({ name: "A" }),
            vstr(fixture("basic.vue")).render({ name: "A" }),
        ])
        expect(out1).toBe(out2)
    })

    test("noCache forces fresh compile", async () => {
        const [out1, out2] = await Promise.all([
            vstr(fixture("basic.vue"), { noCache: true }).render({ name: "A" }),
            vstr(fixture("basic.vue"), { noCache: true }).render({ name: "A" }),
        ])
        expect(out1).toBe(out2)
    })

    test("clearCache forces recompile on next render", async () => {
        await vstr(fixture("basic.vue")).render({ name: "A" })
        vstr.clearCache()
        const out = await vstr(fixture("basic.vue")).render({ name: "fresh" })
        expect(out).toContain("Hello fresh")
    })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe("vstr — error handling", () => {
    test("throws on missing file", async () => {
        await expect(vstr(fixture("does-not-exist.vue")).render()).rejects.toThrow()
    })

    test("throws on SFC with no template block", async () => {
        await expect(
            vstr.source(`<script setup lang="ts">const x = 1</script>`).render()
        ).rejects.toThrow("no <template> block")
    })
})
