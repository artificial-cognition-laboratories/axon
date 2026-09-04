import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

describe("Air parser: incomplete blocks and done detection", () => {
    it("flush() on an unclosed text block emits incomplete:true with the partial content", () => {
        const parser = Air().parser()
        parser.feed("<text>partial thought")

        const events = parser.flush()

        expect(events).toContainEqual({ type: "text:done", content: "partial thought", incomplete: true })
    })

    it("flush() on an unclosed typescript block emits incomplete:true", () => {
        const parser = Air().parser()
        parser.feed("<script>const x =")

        const events = parser.flush()

        expect(events).toContainEqual({ type: "script:done", content: "const x =", incomplete: true })
    })

    it("flush() on a stream with no open block emits nothing extra", () => {
        const parser = Air().parser()
        parser.feed("<text>done already</text>")

        const events = parser.flush()

        expect(events).toEqual([])
    })

    it("flush() resets state — a parser can be fed again after flush without carrying stale state", () => {
        const parser = Air().parser()
        parser.feed("<text>first, unclosed")
        parser.flush()

        const events = parser.feed("<text>second</text>")

        expect(events).toContainEqual({ type: "text:done", content: "second" })
    })



    it("an empty flush on an idle parser is a no-op", () => {
        const parser = Air().parser()

        expect(parser.flush()).toEqual([])
    })
})
