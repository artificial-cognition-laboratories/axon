import { guardAsi } from "../src/process/runner"

/**
 * A line starting with `(` or `[` continues the previous one — JavaScript
 * reads it as a call or an index, never as a new statement.
 *
 * The REPL walks into this because the contract teaches ending a block with a
 * bare expression, and `({ … })` is the idiomatic way to return an object
 * literal. A real run produced `Promise.all([…]) is not a function`, which
 * names nothing the model did wrong.
 */
describe("REPL: ASI hazards", () => {
    it("separates a trailing object literal from the statement above it", () => {
        const out = guardAsi(`const [a, b] = await Promise.all([1, 2])\n({ a, b })`)
        expect(out).toBe(`const [a, b] = await Promise.all([1, 2])\n;({ a, b })`)
    })

    it("separates a trailing array too", () => {
        expect(guardAsi(`const x = 1\n[1, 2].map(n => n)`)).toContain("\n;[1, 2]")
    })

    it("leaves a genuine multi-line call alone", () => {
        // The previous line ends in an opener, so the next line IS a
        // continuation — inserting a semicolon would break it.
        const code = `const r = await fs.query(\n    { pattern: "x" },\n)`
        expect(guardAsi(code)).toBe(code)
    })

    it("leaves a chained continuation alone", () => {
        const code = `const r = things\n    .filter(Boolean)`
        expect(guardAsi(code)).toBe(code)
    })

    it("never rewrites inside a template literal", () => {
        // A newline there is data, not syntax.
        const code = "const s = `line one\n(not code)\n`"
        expect(guardAsi(code)).toBe(code)
    })

    it("is a no-op on ordinary code", () => {
        const code = `const a = 1\nconst b = 2\nawait fs.read("x")`
        expect(guardAsi(code)).toBe(code)
    })
})

import { describeFailure } from "../src/process/runner"

/**
 * A syntax error, as the model has to read it.
 *
 * `Bun.Transpiler` throws an `AggregateError` whose own `message` is the bare
 * string "Parse error" — line, column and offending text live in `.errors`,
 * which was discarded. Models intermittently emit a corrupted preamble line
 * (`tagger to=fs.edit …` plus junk) ahead of otherwise-valid code, and a real
 * run lost a well-formed 3.6k multi-file edit four times to a diagnostic that
 * named nothing.
 */
describe("REPL: syntax errors name the line", () => {
    const transpile = (code: string): unknown => {
        const t = new Bun.Transpiler({ loader: "ts", target: "bun", replMode: true })
        try { t.transformSync(code); return undefined } catch (e) { return e }
    }

    it("names the failing line and quotes it", () => {
        const out = describeFailure(transpile(`tagger to=fs.list x\nconst r = 1; r`))
        expect(out).toContain("line 1")
        expect(out).toContain("tagger to=fs.list")
        // The bare message alone told the model nothing it could act on.
        expect(out.split("\n").length).toBeGreaterThan(1)
    })

    it("repairs the mojibake Bun hands back for a non-ASCII line", () => {
        const out = describeFailure(transpile(`tagger to=fs.list 彩票直属\nconst r = 1; r`))
        // Quoting Latin-1-read UTF-8 back would show the model corrupted text
        // as its example of what to fix.
        expect(out).toContain("彩票直属")
        expect(out).not.toContain("å½©")
    })

    it("caps the cascade — one bad line produces many follow-on errors", () => {
        const out = describeFailure(transpile(`a b c d e f g h\nconst r = 1; r`))
        const quoted = out.split("\n").filter(l => l.trim().startsWith("line ")).length
        expect(quoted).toBeLessThanOrEqual(3)
    })

    it("passes an ordinary runtime error straight through", () => {
        expect(describeFailure(new Error("boom"))).toBe("boom")
    })
})
