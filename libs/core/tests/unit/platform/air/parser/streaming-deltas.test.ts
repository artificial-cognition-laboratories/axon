import { Air } from "../../../../../src/platform/air"

/** Splits into fixed-size chunks without dropping newlines (unlike a `.{1,n}` regex, where `.` never matches `\n`). */
function chunk(s: string, size: number): string[] {
    const out: string[] = []
    for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
    return out
}

describe("Air parser: streaming deltas", () => {
    it("reassembles a block fed one character at a time", () => {
        const parser = Air().parser()
        const whole = "<text>hello world</text>"

        const events = whole.split("").flatMap(ch => parser.feed(ch))

        const deltas = events.filter(e => e.type === "text:delta").map(e => (e as { content: string }).content)
        expect(deltas.join("")).toBe("hello world")

        const done = events.find(e => e.type === "text:done")
        expect(done).toEqual({ type: "text:done", content: "hello world" })
    })

    it("does not lose content when the opening tag is split across chunks", () => {
        const parser = Air().parser()

        const events = [
            ...parser.feed("<te"),
            ...parser.feed("xt>hello</text>"),
        ]

        expect(events).toContainEqual({ type: "text:done", content: "hello" })
    })

    it("does not lose content when the closing tag is split across chunks", () => {
        const parser = Air().parser()

        const events = [
            ...parser.feed("<text>hello</te"),
            ...parser.feed("xt>"),
        ]

        expect(events).toContainEqual({ type: "text:done", content: "hello" })
    })

    it("does not emit a premature delta containing part of a split closing tag", () => {
        const parser = Air().parser()

        const events = parser.feed("<text>hello</te")
        const deltas = events.filter(e => e.type === "text:delta").map(e => (e as { content: string }).content)

        expect(deltas.join("")).not.toContain("</te")
    })

    it("produces identical done content whether fed whole or in small chunks", () => {
        const content = "line one\nline two\nline three"
        const whole = `<text>${content}</text>`

        const bulkDone = Air().parser().feed(whole).find(e => e.type === "text:done")

        const streamedParser = Air().parser()
        const streamedEvents = chunk(whole, 3).flatMap(c => streamedParser.feed(c))
        const streamedDone = streamedEvents.find(e => e.type === "text:done")

        expect(streamedDone).toEqual(bulkDone)
    })

    it("does not emit deltas for a typescript block fed in small chunks", () => {
        const parser = Air().parser()
        const whole = "<typescript>const x = 1</typescript>"

        const events = chunk(whole, 4).flatMap(c => parser.feed(c))

        expect(events.some(e => e.type === "typescript:delta" as never)).toBe(false)
        expect(events).toContainEqual({ type: "typescript:done", content: "const x = 1" })
    })
})
