/**
 * Invariant tests — every MUST from SPEC.md has a test here.
 * These should never be deleted. If behaviour changes, update the spec first.
 */
import { test, expect, describe } from "bun:test"
import { resolve } from "path"
import { vstr } from "../src/index"

const fixture = (name: string) => resolve(import.meta.dir, "fixtures", name)

// ─── INV-1: .vue and .prompt render identically ───────────────────────────────

describe("INV-1: .vue and .prompt files render identically", () => {
    test("file render and equivalent source string produce the same output", async () => {
        const fileOut = await vstr(fixture("basic.vue"), { noCache: true }).render({ name: "Test" })

        const vueOut = await vstr.source(`
<template>
    <div>
        <h1>Hello {{ name }}</h1>
        <p>This is a basic test.</p>
    </div>
</template>
<script setup lang="ts">
const { name = "world" } = defineProps<{ name?: string }>()
</script>`, { noCache: true }).render({ name: "Test" })

        expect(fileOut).toBe(vueOut)
    })
})

// ─── INV-2: Component import chains ──────────────────────────────────────────

describe("INV-2: follows component import chain recursively", () => {
    test("renders a component imported by the root", async () => {
        const out = await vstr(fixture("with-component.vue"), { noCache: true }).render()
        expect(out).toContain("badge:alpha")
    })

    test("renders a component imported by a sub-component (depth > 1)", async () => {
        const out = await vstr(fixture("with-slots.vue"), { noCache: true }).render()
        expect(out).toContain("Slot Header")
        expect(out).toContain("Default slot content")
    })
})

// ─── INV-3: Top-level await in script setup ───────────────────────────────────

describe("INV-3: top-level await in script setup", () => {
    test("awaits async context function before rendering", async () => {
        const out = await vstr(fixture("async-setup.vue"), {
            noCache: true,
            context: {
                fetchData: async () => "fetched-value",
                transform: (v: string) => `transformed:${v}`,
            },
        }).render()
        expect(out).toContain("fetched-value")
        expect(out).toContain("transformed:fetched-value")
    })

    test("multiple sequential awaits in setup all resolve", async () => {
        const out = await vstr.source(`
<template><p>{{ a }} {{ b }}</p></template>
<script setup lang="ts">
const a = await step1()
const b = await step2(a)
</script>`, {
            context: {
                step1: async () => "first",
                step2: async (v: string) => `second-${v}`,
            },
        }).render()
        expect(out).toContain("first")
        expect(out).toContain("second-first")
    })
})

// ─── INV-4: Vue template directives ──────────────────────────────────────────

describe("INV-4: Vue template directives work natively", () => {
    test("v-if renders when true", async () => {
        const out = await vstr(fixture("vue-directives.vue"), { noCache: true }).render({ a: true })
        expect(out).toContain("branch-alpha")
        expect(out).not.toContain("branch-beta")
        expect(out).not.toContain("branch-gamma")
    })

    test("v-else-if renders when first is false", async () => {
        const out = await vstr(fixture("vue-directives.vue"), { noCache: true }).render({ a: false, b: true })
        expect(out).not.toContain("branch-alpha")
        expect(out).toContain("branch-beta")
        expect(out).not.toContain("branch-gamma")
    })

    test("v-else renders when all conditions false", async () => {
        const out = await vstr(fixture("vue-directives.vue"), { noCache: true }).render({ a: false, b: false })
        expect(out).not.toContain("branch-alpha")
        expect(out).not.toContain("branch-beta")
        expect(out).toContain("branch-gamma")
    })

    test("v-for renders each item with index", async () => {
        const out = await vstr(fixture("vue-directives.vue"), { noCache: true }).render({ items: ["x", "y", "z"] })
        expect(out).toContain("0:x")
        expect(out).toContain("1:y")
        expect(out).toContain("2:z")
    })

    test("v-show renders element (SSR: display:none inline style when false)", async () => {
        const html = await vstr(fixture("vue-directives.vue"), { noCache: true, format: "html" }).render({ visible: false })
        expect(html).toContain("display:none")
        expect(html).toContain("ShowTarget")
    })

    test("v-show renders element normally when true", async () => {
        const out = await vstr(fixture("vue-directives.vue"), { noCache: true }).render({ visible: true })
        expect(out).toContain("ShowTarget")
    })

    test("v-bind binds attribute value", async () => {
        const html = await vstr(fixture("vue-directives.vue"), { noCache: true, format: "html" }).render({ cls: "my-class" })
        expect(html).toContain("my-class")
    })
})

// ─── INV-5: Slots ─────────────────────────────────────────────────────────────

describe("INV-5: slots work natively", () => {
    test("default slot content renders inside layout", async () => {
        const out = await vstr(fixture("with-slots.vue"), { noCache: true }).render()
        expect(out).toContain("Default slot content")
    })

    test("named slot content renders in correct position", async () => {
        const out = await vstr(fixture("with-slots.vue"), { noCache: true }).render()
        expect(out).toContain("Slot Header")
    })

    test("named slot and default slot both render", async () => {
        const out = await vstr(fixture("with-slots.vue"), { noCache: true }).render()
        expect(out).toContain("Slot Header")
        expect(out).toContain("Default slot content")
    })
})

// ─── INV-6: Globally registered components ────────────────────────────────────

describe("INV-6: globally registered components", () => {
    test("component registered via options renders without import", async () => {
        const out = await vstr.source(`
<template><div><GlobalComp label="hello" /></div></template>`, {
            components: { GlobalComp: fixture("components/badge.vue") },
        }).render()
        expect(out).toContain("badge:hello")
    })
})

// ─── INV-7 & INV-8: Context injection and isolation ──────────────────────────

describe("INV-7/8: context injection and isolation", () => {
    test("context globals available as bare identifiers in script setup", async () => {
        const out = await vstr.source(`
<template><p>{{ val }}</p></template>
<script setup lang="ts">
const val = myFn()
</script>`, { context: { myFn: () => "from-context" } }).render()
        expect(out).toContain("from-context")
    })

    test("context does not leak between independent render calls", async () => {
        const source = `
<template><p>{{ val }}</p></template>
<script setup lang="ts">
const val = myFn()
</script>`
        const [a, b] = await Promise.all([
            vstr.source(source, { noCache: true, context: { myFn: () => "result-a" } }).render(),
            vstr.source(source, { noCache: true, context: { myFn: () => "result-b" } }).render(),
        ])
        expect(a).toContain("result-a")
        expect(b).toContain("result-b")
        expect(a).not.toContain("result-b")
        expect(b).not.toContain("result-a")
    })
})

// ─── INV-9: Introspect without execute ───────────────────────────────────────

describe("INV-9: introspect without compile or execute", () => {
    test("introspect returns prop metadata without running setup", () => {
        // context.vue uses injected globals — if setup ran without them it would throw
        const props = vstr(fixture("context.vue")).introspect()
        expect(Array.isArray(props)).toBe(true)
    })

    test("introspect returns correct metadata for all prop types", () => {
        const props = vstr(fixture("conditional.vue")).introspect()
        const show = props.find(p => p.name === "show")
        const items = props.find(p => p.name === "items")
        expect(show?.type).toBe("boolean")
        expect(show?.required).toBe(false)
        expect(items?.type).toBe("string[]")
        expect(items?.required).toBe(false)
    })

    test("required and optional props marked correctly via vstr.source", () => {
        const props = vstr.source(`
<template><p>{{ x }}</p></template>
<script setup lang="ts">
const { x } = defineProps<{ x: string; y?: number }>()
</script>`).introspect()
        expect(props.find(p => p.name === "x")?.required).toBe(true)
        expect(props.find(p => p.name === "y")?.required).toBe(false)
    })
})

// ─── INV-10: Output formats ───────────────────────────────────────────────────

describe("INV-10: output formats", () => {
    test("markdown format converts headings", async () => {
        const out = await vstr(fixture("basic.vue")).render({ name: "X" })
        expect(out).toMatch(/^# Hello X/m)
    })

    test("html format returns raw tags", async () => {
        const out = await vstr(fixture("basic.vue"), { format: "html" }).render({ name: "X" })
        expect(out).toContain("<h1>")
        expect(out).not.toMatch(/^#/)
    })

    test("text format strips all tags", async () => {
        const out = await vstr(fixture("basic.vue"), { format: "text" }).render({ name: "X" })
        expect(out).not.toContain("<")
        expect(out).not.toContain(">")
        expect(out).toContain("Hello X")
    })
})

// ─── MUST NOT: npm imports stripped ──────────────────────────────────────────

describe("MUST NOT: npm imports are stripped, not executed", () => {
    test("npm import in script setup does not cause module resolution error", async () => {
        const out = await vstr.source(`
<template><p>ok</p></template>
<script setup lang="ts">
import { something } from "some-npm-package-that-does-not-exist"
</script>`).render()
        expect(out).toContain("ok")
    })
})

// ─── MUST NOT: style blocks silently ignored ──────────────────────────────────

describe("MUST NOT: style blocks are silently ignored", () => {
    test("style block does not appear in output", async () => {
        const out = await vstr.source(`
<template><p>styled</p></template>
<style>p { color: red; }</style>`).render()
        expect(out).not.toContain("color: red")
        expect(out).toContain("styled")
    })
})

// ─── MUST NOT: no template block throws clearly ───────────────────────────────

describe("MUST NOT: missing template throws clearly", () => {
    test("source with no template block throws with clear message", async () => {
        await expect(
            vstr.source(`<script setup lang="ts">const x = 1</script>`).render()
        ).rejects.toThrow("no <template> block")
    })
})

// ─── Stray content: valid empty blocks pass, real stray content throws ────────

describe("stray-content check", () => {
    test("an empty <script setup> is not stray content", async () => {
        // @vue/compiler-sfc drops empty blocks from the descriptor, so the
        // tags remain in source unaccounted for — they must not be flagged.
        const out = await vstr.source(`<template><p>hi</p></template>
<script setup lang="ts">
</script>`).render()
        expect(out).toContain("hi")
    })

    test("an empty <style> block is not stray content", async () => {
        const out = await vstr.source(`<template><p>hi</p></template>
<style></style>`).render()
        expect(out).toContain("hi")
    })

    test("real content outside every block still throws", async () => {
        await expect(
            vstr.source(`<template><p>hi</p></template>
OOPS a stray line
<script setup></script>`).render()
        ).rejects.toThrow("has content outside")
    })
})
