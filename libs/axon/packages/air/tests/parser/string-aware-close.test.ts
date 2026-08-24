import { Air } from "../../src"

describe("Air parser: string-aware close-tag scanning", () => {
    it("does not close early on a closing tag written as a double-quoted string literal", () => {
        const parser = Air().parser()
        const code = `const s = "</script>"`

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("does not close early on a closing tag written as a single-quoted string literal", () => {
        const parser = Air().parser()
        const code = `const s = '</script>'`

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("does not close early on a closing tag written inside a template literal", () => {
        const parser = Air().parser()
        const code = "const s = `</script>`"

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("respects escaped quotes inside a string when scanning for the real close tag", () => {
        const parser = Air().parser()
        const code = `const s = "he said \\"</script>\\" once"`

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("closes correctly when the close tag genuinely follows string content", () => {
        const parser = Air().parser()
        const code = `const s = "just a string"`

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("applies string-aware scanning to script blocks too", () => {
        const parser = Air().parser()
        const code = `const s = "</script>"`

        const events = parser.feed(`<script>${code}</script>`)

        expect(events).toContainEqual({ type: "script:done", content: code })
    })

    it("text blocks are not string-aware — plain text content closes on the first literal close tag", () => {
        const parser = Air().parser()

        // <text> is a streamable block: it uses plain indexOf, not the
        // string-aware scanner (that's a typescript/shell-only concern).
        const events = parser.feed(`<text>a "</text>" appears here</text>`)

        const done = events.find(e => e.type === "text:done")
        expect(done).toEqual({ type: "text:done", content: `a "` })
    })
})
