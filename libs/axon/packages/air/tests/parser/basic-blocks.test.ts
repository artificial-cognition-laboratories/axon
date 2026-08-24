import { Air } from "../../src"

describe("Air parser: basic blocks", () => {
    it("parses a complete <text> block fed whole", () => {
        const parser = Air().parser()

        const events = parser.feed("<text>hello world</text>")

        expect(events).toContainEqual({ type: "text:delta", content: "hello world" })
        expect(events).toContainEqual({ type: "text:done", content: "hello world" })
    })

    it("parses a complete <thinking> block fed whole", () => {
        const parser = Air().parser()

        const events = parser.feed("<thinking>reasoning here</thinking>")

        expect(events).toContainEqual({ type: "thinking:delta", content: "reasoning here" })
        expect(events).toContainEqual({ type: "thinking:done", content: "reasoning here" })
    })

    it("parses a complete <script> block without emitting deltas", () => {
        const parser = Air().parser()

        const events = parser.feed("<script>console.log(1)</script>")

        expect(events.some(e => e.type === "typescript:delta" as never)).toBe(false)
        expect(events).toContainEqual({ type: "script:done", content: "console.log(1)" })
    })

    it("parses a complete <script> block without emitting deltas", () => {
        const parser = Air().parser()

        const events = parser.feed("<script>const a = 1</script>")

        expect(events.some(e => e.type === "script:delta" as never)).toBe(false)
        expect(events).toContainEqual({ type: "script:done", content: "const a = 1" })
    })


    it("parses multiple blocks fed in one chunk, in order", () => {
        const parser = Air().parser()

        const events = parser.feed("<text>first</text><text>second</text>")

        const done = events.filter(e => e.type === "text:done")
        expect(done).toEqual([
            { type: "text:done", content: "first" },
            { type: "text:done", content: "second" },
        ])
    })

    it("ignores bare text outside any tag", () => {
        const parser = Air().parser()

        const events = parser.feed("stray preamble <text>hello</text>")

        expect(events).toContainEqual({ type: "text:done", content: "hello" })
        expect(events.some(e => "content" in e && e.content === "stray preamble ")).toBe(false)
    })

    it("tolerates attributes on the opening tag", () => {
        const parser = Air().parser()

        const events = parser.feed(`<text lang="md">hello</text>`)

        expect(events).toContainEqual({ type: "text:done", content: "hello" })
    })
})
