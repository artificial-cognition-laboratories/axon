import { Output } from "../src/output"
import type { AxonScope } from "@arcforge/types"

/**
 * The output type, end to end: a string is checked before the model is
 * called, and then enforced against what the model wrote.
 *
 * Behavioural throughout — a source string and a model script go in,
 * diagnostics come out. Nothing here reaches into the language service.
 */

const EMPTY: AxonScope = { modules: [] }

// `flat` installs members as top-level globals; a namespaced module hangs
// them off its name. Both forms are exercised because both reach the model.
const WITH_TOOLS: AxonScope = {
    modules: [
        {
            name: "files",
            flat: true,
            ambientTypes: ["interface FileEntry { name: string; size: number }"],
            members: [{
                name: "list",
                declaration: "function list(path: string): Promise<FileEntry[]>",
            }],
        },
        {
            name: "github",
            members: [{
                name: "stars",
                declaration: "function stars(repo: string): Promise<number>",
            }],
        },
    ],
}

function out(scope: AxonScope = EMPTY) {
    return Output({ scope: () => scope })
}

describe("Output: pre-flight", () => {
    it("accepts a type expression", () => {
        const compiled = out().compile("{ files: number }")
        expect(compiled.declaration).toContain("result")
    })

    it("accepts a primitive", () => {
        expect(() => out().compile("number")).not.toThrow()
    })

    it("accepts an array type", () => {
        expect(() => out().compile("string[]")).not.toThrow()
    })

    it("accepts a declaration block naming Output", () => {
        expect(() => out().compile(`
            type Issue = { file: string, line: number }
            type Output = { issues: Issue[] }
        `)).not.toThrow()
    })

    // The whole point of checking first: a typo costs nothing.
    it("throws on a syntax error rather than calling the model", () => {
        expect(() => out().compile("{ files: number")).toThrow()
    })

    it("throws on a type that does not exist", () => {
        expect(() => out().compile("{ issues: Issue[] }")).toThrow()
    })

    it("throws on an empty string", () => {
        expect(() => out().compile("   ")).toThrow()
    })

    it("resolves a type the capsule's own tools declare", () => {
        expect(() => out(WITH_TOOLS).compile("{ files: FileEntry[] }")).not.toThrow()
    })
})

describe("Output: enforcement", () => {
    it("passes a script whose result matches the type", () => {
        const compiled = out().compile("{ files: number }")
        expect(compiled.check(`const result = { files: 3 }`)).toEqual([])
    })

    it("reports a wrong property type", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(`const result = { files: "three" }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("string")
    })

    it("reports a missing property", () => {
        const compiled = out().compile("{ files: number, ok: boolean }")
        const found = compiled.check(`const result = { files: 1 }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("ok")
    })

    it("reports a result that was never declared", () => {
        const compiled = out().compile("{ files: number }")
        expect(compiled.check(`const other = 1`).length).toBeGreaterThan(0)
    })

    it("points diagnostics at the line the model wrote", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(`const a = 1\nconst b = 2\nconst result = { files: "no" }`)
        expect(found[0]!.line).toBe(3)
    })

    it("checks nested shapes", () => {
        const compiled = out().compile(`
            type Issue = { file: string, line: number }
            type Output = { issues: Issue[] }
        `)
        expect(compiled.check(`const result = { issues: [{ file: "a.ts", line: 1 }] }`)).toEqual([])
        expect(compiled.check(`const result = { issues: [{ file: "a.ts" }] }`).length).toBeGreaterThan(0)
    })

    it("allows top-level await, as the capsule REPL does", () => {
        const compiled = out(WITH_TOOLS).compile("{ files: number }")
        const found = compiled.check(`const entries = await list("src")\nconst result = { files: entries.length }`)
        expect(found).toEqual([])
    })

    it("resolves a namespaced tool the capsule declares", () => {
        const compiled = out(WITH_TOOLS).compile("{ stars: number }")
        expect(compiled.check(`const result = { stars: await github.stars("a/b") }`)).toEqual([])
    })

    it("catches misuse of a tool, not just the output shape", () => {
        const compiled = out(WITH_TOOLS).compile("{ files: number }")
        // list() takes a string; passing a number is a real error the model
        // should hear about, and it costs nothing extra to detect.
        const found = compiled.check(`const entries = await list(42)\nconst result = { files: entries.length }`)
        expect(found.length).toBeGreaterThan(0)
    })

    it("is reusable across many checks", () => {
        const compiled = out().compile("{ n: number }")
        expect(compiled.check(`const result = { n: 1 }`)).toEqual([])
        expect(compiled.check(`const result = { n: "x" }`).length).toBeGreaterThan(0)
        expect(compiled.check(`const result = { n: 2 }`)).toEqual([])
    })
})

/**
 * TypeScript's assignability check proves a program is well-typed, not that
 * a value has a shape. These are the two ways well-typed code lies about a
 * type, and both are ordinary things to write — so both must be rejected
 * while an output contract is in force, or a passing check proves nothing.
 */
describe("Output: soundness", () => {
    const LOOSE: AxonScope = {
        modules: [{
            name: "db",
            flat: true,
            members: [{ name: "query", declaration: "function query(sql: string): Promise<any>" }],
        }],
    }

    // The wider hole in practice: nobody writes `any`, it arrives from a
    // loosely-typed tool and every check above it succeeds vacuously.
    it("rejects a result that resolved to any via a tool", () => {
        const compiled = out(LOOSE).compile("{ rows: number }")
        const found = compiled.check(`const rows = await query("select 1")\nconst result = { rows }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("any")
    })

    it("rejects a result that resolved to any via JSON.parse", () => {
        const compiled = out().compile("{ n: number }")
        const found = compiled.check(`const raw = JSON.parse("{}")\nconst result = raw`)
        expect(found.length).toBeGreaterThan(0)
    })

    it("rejects an explicitly annotated any", () => {
        const compiled = out().compile("{ n: number }")
        expect(compiled.check(`const raw: any = { n: 1 }\nconst result = raw`).length).toBeGreaterThan(0)
    })

    // `{ n: any }` is exactly as unchecked as a bare `any`.
    it("rejects any nested inside the result shape", () => {
        const compiled = out().compile("{ n: number }")
        expect(compiled.check(`const raw: any = 1\nconst result = { n: raw }`).length).toBeGreaterThan(0)
    })

    // The diagnostic tells the model to narrow — so narrowing must work.
    it("accepts a value narrowed out of any", () => {
        const compiled = out(LOOSE).compile("{ rows: number }")
        expect(compiled.check(`const r = await query("x")\nconst result = { rows: Number(r) }`)).toEqual([])
    })

    // unknown is assignable to nothing without narrowing, so it already
    // fails the assignability check with a real message — it is not a hole.
    it("reports unknown as an ordinary type error, not an any violation", () => {
        const compiled = out().compile("{ n: number }")
        const found = compiled.check(`const raw: unknown = 1\nconst result = raw`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).not.toContain("resolves to `any`")
    })

    // The assignability check reads the DECLARATION. A later assignment
    // replaces the value the template actually serialises, so what ships is
    // no longer what was proven.
    it("rejects a result reassigned after it is declared", () => {
        const compiled = out().compile("{ n: number }")
        const found = compiled.check(`let result = { n: 1 }\nresult = JSON.parse("{}")`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("reassigned")
    })

    // `declare` states a type and produces no value — it would serialise to
    // undefined having passed every check.
    it("rejects a result that is declared but never built", () => {
        const compiled = out().compile("{ n: number }")
        const found = compiled.check(`declare const result: { n: number }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("never assigned")
    })

    // Mutating a property does not change the shape that was proven.
    it("allows mutating a property of the result", () => {
        const compiled = out().compile("{ n: number }")
        expect(compiled.check(`const result = { n: 0 }\nresult.n = 5`)).toEqual([])
    })

    it("allows a let binding assigned once at its declaration", () => {
        const compiled = out().compile("{ n: number }")
        expect(compiled.check(`let result = { n: 1 }`)).toEqual([])
    })

    it("does not hang on a recursive output type", () => {
        const compiled = out().compile(`type Tree = { kids: Tree[] }\ntype Output = { root: Tree }`)
        expect(compiled.check(`const result = { root: { kids: [] } }`)).toEqual([])
    })
})

describe("Output: escape hatches", () => {
    // TypeScript is not sound at runtime; an assertion is how well-typed
    // code emits a mistyped value. Banning it closes the reachable gap.
    it("rejects an `as` assertion to the output type", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(`const result = JSON.parse("{}") as { files: number }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("assertion")
    })

    it("rejects an angle-bracket assertion", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(`const raw: any = {}\nconst result = <{ files: number }>raw`)
        expect(found.some(f => f.message.includes("assertion"))).toBe(true)
    })

    it("allows `as const`, which only narrows", () => {
        const compiled = out().compile("{ files: number }")
        expect(compiled.check(`const result = { files: 3 } as const`)).toEqual([])
    })

    // Same escape as `as`, different keyword — it asserts a shape rather
    // than producing one.
    it("rejects `satisfies`", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(`const result = { files: 1 } satisfies { files: number }`)
        expect(found.length).toBeGreaterThan(0)
        expect(found[0]!.message).toContain("satisfies")
    })

    it("rejects an assertion anywhere in the script, not only at the binding", () => {
        const compiled = out().compile("{ files: number }")
        const found = compiled.check(
            `const raw = JSON.parse("{}") as { files: number }\nconst result = { files: raw.files }`
        )
        expect(found.length).toBeGreaterThan(0)
    })
})
