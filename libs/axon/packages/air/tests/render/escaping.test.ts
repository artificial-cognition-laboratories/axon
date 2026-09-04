import type { AxonEntry, AxonEntryEvent } from "@arcforge/types"
import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

let seq = 1
function entry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K], runId?: string): AxonEntry {
    return { id: `${type}-${seq}`, type, time: { ms: Date.now(), seq: seq++ }, ...(runId ? { context: { runId } } : {}), data } as AxonEntry
}

/**
 * A tool result is arbitrary bytes off the disk, and it must never be able to
 * alter the document that carries it.
 *
 * `<stdout>` bodies went through `formatCapsuleOutput` but never through
 * `esc()`. A grep over a Vue codebase returned lines containing `<template>`
 * and an unterminated `/*`, which landed raw in the timeline — every tag after
 * that point read as content of a block that never closed.
 */
describe("Air render: a tool result cannot break the document", () => {
    const render = (content: string): string =>
        Air().render({
            history: [
                entry("cognet:action:typescript", { id: "a1", content: "grep()" }, "r1"),
                entry("cognet:action:result", { for: "a1", ok: true, content }, "r1"),
            ],
        }).at(-1)!.content

    it("escapes markup that appears in captured output", () => {
        const out = render('{"line":1,"text":"<template>"}')
        expect(out).toContain("&lt;template&gt;")
        expect(out).not.toContain("<template>")
    })

    it("cannot close its own block early", () => {
        const out = render("here is </stdout> and more")
        // Exactly one real closing tag: the one the renderer wrote.
        expect(out.match(/<\/stdout>/g)).toHaveLength(1)
        expect(out).toContain("&lt;/stdout&gt;")
    })

    it("escapes an error message as well as the body", () => {
        const out = Air().render({
            history: [
                entry("cognet:action:typescript", { id: "a2", content: "boom()" }, "r1"),
                entry("cognet:action:result", {
                    for: "a2", ok: false, content: "<script>x</script>",
                    error: { kind: "exception", message: "failed at <template>" },
                }, "r1"),
            ],
        }).at(-1)!.content
        expect(out).not.toContain("<template>")
        expect(out).not.toContain("<script>")
    })
})
