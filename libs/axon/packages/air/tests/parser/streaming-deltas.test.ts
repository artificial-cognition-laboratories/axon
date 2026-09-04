import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

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
        const whole = "<script>const x = 1</script>"

        const events = chunk(whole, 4).flatMap(c => parser.feed(c))

        expect(events.some(e => e.type === "typescript:delta" as never)).toBe(false)
        expect(events).toContainEqual({ type: "script:done", content: "const x = 1" })
    })
})

/**
 * An opening tag carrying the attributes the model reads in its own history.
 *
 * The idle buffer holds back enough characters to complete a tag split across
 * chunks. That allowance was sized for `lang="json"` — twelve characters —
 * while history renders `<script from="agent" id="e18" lang="typescript">`,
 * which models copy. Thirty-nine characters of attributes overran it, so the
 * tag's prefix flushed as stray text, the block never opened, and a run
 * failed fourteen consecutive VALID scripts as OUTPUT_EMPTY.
 *
 * Only reachable when a chunk boundary lands inside the tag, which is why it
 * survived every whole-string test and appeared only against a live provider.
 */
describe("Air parser: attributes copied from history", () => {
    const reply = `<script from="agent" id="e18" lang="typescript">\nconst page = await fs.read("x"); page\n</script>\n<done/>`

    it("parses a fully attributed script streamed in small chunks", () => {
        for (const size of [1, 3, 7, 13, 29]) {
            const parser = Air().parser()
            const events = []
            for (let i = 0; i < reply.length; i += size) events.push(...parser.feed(reply.slice(i, i + size)))
            events.push(...parser.flush())

            const done = events.find(e => e.type === "script:done") as { content?: string } | undefined
            expect(done).toBeDefined()
            expect(done!.content).toContain("fs.read")
            expect(events.some(e => e.type === "done")).toBe(true)
        }
    })

    it("keeps the declared lang when the tag is split mid-attribute", () => {
        const parser = Air().parser()
        const input = `<text from="agent" id="u1" channel="user" lang="json">{"a":1}</text>`
        const events = []
        for (let i = 0; i < input.length; i += 5) events.push(...parser.feed(input.slice(i, i + 5)))
        events.push(...parser.flush())

        const open = events.find(e => e.type === "text:open") as { lang?: string } | undefined
        expect(open?.lang).toBe("json")
    })
})
