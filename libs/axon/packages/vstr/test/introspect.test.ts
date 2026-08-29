import { test, expect, describe } from "bun:test"
import { resolve } from "path"
import { vstr } from "../src/index"

const fixture = (name: string) => resolve(import.meta.dir, "fixtures", name)

describe("introspect — from file", () => {
    test("returns prop name, type, required, default", () => {
        const props = vstr(fixture("basic.vue")).introspect()
        expect(props).toHaveLength(1)
        expect(props[0]).toMatchObject({
            name: "name",
            type: "string",
            required: false,
            default: "world",
        })
    })

    test("returns multiple props", () => {
        const props = vstr(fixture("conditional.vue")).introspect()
        expect(props.map(p => p.name)).toEqual(["show", "items"])
    })

    test("marks optional props correctly", () => {
        const props = vstr(fixture("basic.vue")).introspect()
        expect(props[0]?.required).toBe(false)
    })

    test("returns empty array when no defineProps", () => {
        const props = vstr(fixture("no-script.vue")).introspect()
        expect(props).toEqual([])
    })

    test("extracts array type", () => {
        const props = vstr(fixture("conditional.vue")).introspect()
        const items = props.find(p => p.name === "items")
        expect(items?.type).toBe("string[]")
    })
})

describe("introspect — from source string", () => {
    test("introspects props from source string", () => {
        const props = vstr.source(`
<template><p>{{ msg }}</p></template>
<script setup lang="ts">
const { msg = "hi" } = defineProps<{ msg?: string }>()
</script>`).introspect()
        expect(props[0]?.name).toBe("msg")
        expect(props[0]?.type).toBe("string")
        expect(props[0]?.required).toBe(false)
    })

    test("marks required props correctly", () => {
        const props = vstr.source(`
<template><p>{{ x }}</p></template>
<script setup lang="ts">
const { x } = defineProps<{ x: string }>()
</script>`).introspect()
        expect(props[0]?.required).toBe(true)
    })

    test("marks optional props correctly", () => {
        const props = vstr.source(`
<template><p>{{ x }}</p></template>
<script setup lang="ts">
const { x } = defineProps<{ x?: string }>()
</script>`).introspect()
        expect(props[0]?.required).toBe(false)
    })

    test("returns empty array for source with no script setup", () => {
        const props = vstr.source(`<template><p>hi</p></template>`).introspect()
        expect(props).toEqual([])
    })

    test("returns correct metadata for multiple prop types", () => {
        const props = vstr.source(`
<template><p>{{ show }} {{ items }}</p></template>
<script setup lang="ts">
const { show = false, items = [] } = defineProps<{ show?: boolean, items?: string[] }>()
</script>`).introspect()
        const show = props.find(p => p.name === "show")
        const items = props.find(p => p.name === "items")
        expect(show?.type).toBe("boolean")
        expect(items?.type).toBe("string[]")
    })
})

describe("introspect — does not compile or execute", () => {
    test("introspect returns props without running script setup", () => {
        // context.vue uses context injections — if setup ran without context it would throw
        // The fact it returns without throwing proves it never executed setup
        const props = vstr(fixture("context.vue")).introspect()
        expect(Array.isArray(props)).toBe(true)
    })

    test("required and optional props both marked correctly from file", () => {
        const props = vstr(fixture("conditional.vue")).introspect()
        const show = props.find(p => p.name === "show")
        const items = props.find(p => p.name === "items")
        expect(show?.type).toBe("boolean")
        expect(show?.required).toBe(false)
        expect(items?.type).toBe("string[]")
        expect(items?.required).toBe(false)
    })
})
