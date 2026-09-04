import { Air } from "../../src"
import { describe, it, expect } from "bun:test"
import MarkdownIt from "markdown-it"

/**
 * A `<text>` body arrives indented, and markdown must survive it.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * Four leading spaces IS an indented code block in CommonMark. The renderer
 * used to indent agent speech to sit inside its turn, so models copied it —
 * a transcript is the strongest instruction there is — and a 9,439-character
 * reply reached the user as ONE `code_block` instead of 68 paragraphs, 14
 * headings and 24 fences. It rendered as raw source: unstyled, unwrapped, and
 * clipped, because a code block's height is its unwrapped line count.
 *
 * The renderer no longer indents markdown. This guards the other half: a model
 * formatting its own XML however it likes must not be able to destroy its own
 * message.
 */

/** Feed in small slices, so chunk boundaries land inside indentation. */
function stream(raw: string, size = 7): { deltas: string; done: string } {
    const parser = Air().parser()
    let deltas = ""
    let done = ""

    const take = (events: ReturnType<typeof parser.feed>): void => {
        for (const event of events) {
            if (event.type === "text:delta") deltas += event.content
            if (event.type === "text:done") done = event.content
        }
    }

    for (let i = 0; i < raw.length; i += size) take(parser.feed(raw.slice(i, i + size)))
    take(parser.flush())

    return { deltas, done }
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
const kinds = (text: string): Set<string> => new Set(md.parse(text, {}).map(t => t.type))

describe("indented <text> bodies", () => {
    it("strips the body's own indent so markdown parses as markdown", () => {
        const raw = [
            `<text from="agent" lang="md">`,
            `    ## Heading`,
            ``,
            `    A paragraph of prose.`,
            `</text>`,
        ].join("\n")

        const { deltas } = stream(raw)

        // The whole point: NOT one code_block.
        expect(kinds(deltas).has("code_block")).toBe(false)
        expect(kinds(deltas).has("heading_open")).toBe(true)
        expect(kinds(deltas).has("paragraph_open")).toBe(true)
    })

    it("keeps relative indentation inside the block", () => {
        const raw = [
            `<text from="agent" lang="md">`,
            `    - top`,
            `      - nested`,
            `</text>`,
        ].join("\n")

        // Only the block's OWN indent goes. A fixed four-column strip would
        // flatten the nested item into a sibling; markdown structure below the
        // body's baseline is content.
        expect(stream(raw).deltas).toContain("  - nested")
    })

    it("survives a chunk boundary inside the indentation", () => {
        const raw = `<text from="agent" lang="md">\n    hello\n    world\n</text>`

        // Indentation is a line-start property and a delta is an arbitrary
        // slice, so the strip has to carry across chunks. Size 1 puts a
        // boundary between every single space.
        expect(stream(raw, 1).deltas.trim()).toBe("hello\nworld")
    })

    it("leaves an unindented body untouched", () => {
        const raw = `<text from="agent" lang="md">\n# Title\n\nBody text.\n</text>`

        expect(stream(raw).deltas.trim()).toBe("# Title\n\nBody text.")
    })

    it("never strips indentation from a script", () => {
        const raw = [
            `<script from="agent" id="e1" lang="typescript">`,
            `const o = {`,
            `    nested: 1,`,
            `}`,
            `</script>`,
        ].join("\n")

        const parser = Air().parser()
        let code = ""
        for (const event of [...parser.feed(raw), ...parser.flush()]) {
            if (event.type === "script:done") code = event.content
        }

        // Leading whitespace is CONTENT in code. Dedenting a program is
        // corruption, not cleanup.
        expect(code).toContain("    nested: 1,")
    })

    it("measures each block's indent independently", () => {
        // A shallow block followed by a deep one. Reusing the first block's
        // width strips too little from the second, so the deltas stay indented
        // while `text:done` comes out clean — the divergence below, but only
        // reachable in this order.
        const raw = [
            `<text from="agent" lang="md">`,
            `  ab`,
            `</text>`,
            `<text from="agent" lang="md">`,
            `        deep body`,
            `</text>`,
        ].join("\n")

        const { deltas } = stream(raw, 5)

        expect(deltas).toContain("deep body")
        expect(deltas).not.toContain("      deep body")
    })

    it("streams exactly what it commits", () => {
        const raw = `<text from="agent" lang="md">\n    ## One\n\n    Two.\n</text>\n<done/>`

        const { deltas, done } = stream(raw)

        // The row on screen is built from deltas; the history the model reads
        // back is built from `text:done`. If they disagree, the agent sees a
        // different conversation than the user does.
        expect(deltas.trim()).toBe(done.trim())
        expect(deltas).not.toContain("</text>")
        expect(deltas).not.toContain("<done/>")
    })
})
