import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import ts from "typescript"
import { declareTools } from "@arcforge/platform/build/blueprint/scan/declare"
import { Tools } from "@arcforge/platform/build/blueprint/scan/tools"

/**
 * Deliberate attempts to break the tool pipeline.
 *
 * Everything else in this directory pins behavior we designed. This file
 * assumes the design is wrong somewhere and goes looking. The bar for every
 * case is the same and it is binary: the scan produces a correct scope, or it
 * throws. What must never happen is the third outcome — a scan that succeeds
 * while quietly producing something other than what the author wrote, because
 * that is the shape the reported bug took and nothing downstream can detect it.
 *
 * Cases are drawn from what real tool files actually contain: generics,
 * overloads, re-exports, `export *`, decorators, circular imports, generated
 * code, huge files, unicode, and the various ways TypeScript lets you name a
 * thing. Where a case has no single right answer, the test asserts the binary
 * property (correct OR throws) rather than inventing a preference.
 */

/**
 * Temp roots are swept once at the END of the file, not after each test.
 *
 * A batched fixture (see declareTable) is built in beforeAll and read by every
 * test in its describe, so an afterEach sweep would delete the directory out
 * from under the tests that still need it. Nothing here asserts on the absence
 * of a previous test's files — each root is a fresh mkdtemp — so per-test
 * cleanup was never load-bearing, only tidier.
 */
const roots: string[] = []
afterAll(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function toolsDir(files: Record<string, string>): Promise<{ root: string; dir: string; paths: string[] }> {
    const root = await mkdtemp(join(tmpdir(), "axon-adv-"))
    roots.push(root)
    await mkdir(join(root, ".agent"), { recursive: true })
    const dir = join(root, "src", "tools")
    await mkdir(dir, { recursive: true })
    const paths: string[] = []
    for (const [name, source] of Object.entries(files)) {
        const path = join(dir, name)
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, source)
        paths.push(path)
    }
    return { root, dir, paths }
}

/**
 * Declare a whole TABLE of independent cases in one ts.Program.
 *
 * ts.createProgram() charges a large fixed cost — building the compiler host
 * and loading lib.d.ts is ~700ms — and a trivial marginal one (~20ms per tool
 * file). Measured: one file 986ms, twelve files in one call 740ms, twelve files
 * in twelve calls 5943ms. A table that compiles per case therefore pays the
 * entry fee once per ROW, which is where this file's runtime went.
 *
 * Batching is also what production does. A real agent's src/tools/ is compiled
 * as a single program (see declare.ts: "One ts.Program per directory (not per
 * file)"), so per-case programs were testing a configuration the runtime never
 * uses. This is a fidelity fix that happens to be fast, not a speed hack.
 *
 * Each case gets its own FILE inside one directory, so ES module scoping keeps
 * the cases independent — seventeen files may each export `f` without
 * colliding. Cases that assert on directory-level behaviour (an empty dir, a
 * companion `_h.ts`) cannot share a directory and keep their own root via
 * toolsDir() instead.
 *
 * The returned map is read-only once built: a test looks up its own case and
 * never mutates, which is the only safe form of a shared fixture.
 */
async function declareTable(cases: Record<string, string>): Promise<Map<string, ReturnType<typeof declareTools> extends Map<string, infer V> ? V : never>> {
    const files: Record<string, string> = {}
    for (const label of Object.keys(cases)) files[`${slug(label)}.ts`] = `${cases[label]}\n`

    const { dir, paths } = await toolsDir(files)
    const declared = declareTools(paths)

    // Re-key by LABEL so a test reads its own case by name rather than
    // reconstructing a path — the filename is an implementation detail of the
    // batching, not something each test should have to know.
    const byLabel = new Map<string, ReturnType<typeof declareTools> extends Map<string, infer V> ? V : never>()
    for (const label of Object.keys(cases)) {
        const declaredFile = declared.get(join(dir, `${slug(label)}.ts`))
        if (!declaredFile) throw new Error(`declareTable: no declaration produced for case "${label}"`)
        byLabel.set(label, declaredFile)
    }
    return byLabel
}

/** A case label as a safe, unique filename stem. */
function slug(label: string): string {
    return label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

/** Every declaration this file produces must be parseable TypeScript. */
function assertParses(declaration: string): void {
    const src = ts.createSourceFile("t.d.ts", `declare ${declaration};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const diagnostics = (src as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics
    expect(diagnostics).toHaveLength(0)
}

/** Run the scan; report whether it threw. Never let an unexpected throw pass as a pass. */
async function attempt(root: string): Promise<{ threw: boolean; result?: Awaited<ReturnType<typeof Tools>> }> {
    try {
        return { threw: false, result: await Tools(root) }
    } catch {
        return { threw: true }
    }
}

// ─── Return types the lifter has to survive ──────────────────────────────────

describe("adversarial: return-type shapes the Promise lifter must not corrupt", () => {
    const cases: Record<string, string> = {
        "generic type parameter": "export function id<T>(x: T): T { return x }",
        "union return": "export function f(): string | number { return 1 }",
        "array return": "export function f(): string[] { return [] }",
        "nested generic": "export function f(): Map<string, Array<number>> { return new Map() }",
        "object literal return": "export function f(): { a: number; b: string } { return { a: 1, b: '' } }",
        "function-typed return": "export function f(): (x: number) => string { return String }",
        "tuple return": "export function f(): [string, number] { return ['', 0] }",
        "readonly array": "export function f(): readonly string[] { return [] }",
        "literal type": "export function f(): 'a' | 'b' { return 'a' }",
        "void": "export function f(): void {}",
        "never": "export function f(): never { throw new Error('x') }",
        "null union": "export function f(): string | null { return null }",
        "type predicate": "export function isStr(x: unknown): x is string { return typeof x === 'string' }",
        "conditional type": "export function f<T>(x: T): T extends string ? number : boolean { return null as never }",
        "indexed access": "export function f(): { a: number }['a'] { return 1 }",
        "already a promise": "export async function f(): Promise<number> { return 1 }",
        "promise-like generic": "export function f(): Promise<Map<string, number>> { return null as never }",
    }

    // One program for the whole table — see declareTable(). Every case below
    // reads its own entry and never mutates, so the tests stay independent.
    let declared: Awaited<ReturnType<typeof declareTable>>
    beforeAll(async () => { declared = await declareTable(cases) })

    for (const label of Object.keys(cases)) {
        test(`${label} produces parseable declarations`, () => {
            for (const fn of declared.get(label)!.fns) assertParses(fn.declaration)
        })
    }

    test("a type predicate is not wrapped into a nonsensical Promise<x is string>", () => {
        // `x is string` is only legal in a return-type position on a sync
        // predicate. Promise<x is string> does not parse, and a predicate tool
        // is genuinely unusable across the capsule boundary anyway.
        const decl = declared.get("type predicate")!.fns[0]?.declaration ?? ""

        expect(decl).not.toContain("Promise<x is")
        assertParses(decl)
    })

    test("an already-async tool is never double-wrapped", () => {
        expect(declared.get("already a promise")!.fns[0]?.declaration).not.toContain("Promise<Promise<")
    })

    test("a generic signature keeps its type parameters", () => {
        const decl = declared.get("generic type parameter")!.fns[0]?.declaration ?? ""

        expect(decl).toContain("<T>")
        assertParses(decl)
    })
})

// ─── Export forms ────────────────────────────────────────────────────────────

describe("adversarial: export forms", () => {
    const forms: Record<string, string> = {
        "arrow const": "export const f = (a: number) => a\n",
        "async arrow const": "export const f = async (a: number) => a\n",
        "function expression const": "export const f = function (a: number) { return a }\n",
        "object of methods": "export const api = { async get(): Promise<string> { return '' } }\n",
        "default export": "export default function f(a: number) { return a }\n",
        "renamed export": "function inner(a: number) { return a }\nexport { inner as outer }\n",
        "re-export from sibling": "export { helper } from './_h'\n",
        "star re-export": "export * from './_h'\n",
        "class export": "export class Thing { x = 1 }\n",
        "const enum": "export const enum E { A }\n",
        "exported type only": "export type Only = { a: number }\n",
        "no exports at all": "const private1 = 1\n",
        "empty file": "",
        "only comments": "// nothing here\n",
    }

    for (const [label, source] of Object.entries(forms)) {
        test(`${label}: succeeds correctly or throws — never a wrong-but-quiet scope`, async () => {
            const files: Record<string, string> = { "t.ts": source }
            if (source.includes("./_h")) files["_h.ts"] = "export function helper(a: number) { return a }\n"
            const { root } = await toolsDir(files)

            const { threw, result } = await attempt(root)
            if (threw) return

            for (const entry of result!.entries) {
                expect(entry.source ?? "").not.toBe("")
                for (const fn of entry.fns) assertParses(fn.declaration)
            }
        }, 30_000)
    }
})

// ─── Structural nasties ──────────────────────────────────────────────────────

describe("adversarial: structures that should not corrupt the scan", () => {
    test("circular imports between tool files", async () => {
        const { root } = await toolsDir({
            "a.ts": "import { b } from './b'\nexport function a(): number { return b() }\n",
            "b.ts": "import { a } from './a'\nexport function b(): number { return 1 }\n",
        })

        const { threw, result } = await attempt(root)
        if (!threw) for (const e of result!.entries) expect(e.source ?? "").not.toBe("")
    }, 30_000)

    test("a tool importing its own directory index", async () => {
        const { root } = await toolsDir({
            "index.ts": "export function idx(): number { return 1 }\n",
            "t.ts": "import { idx } from './index'\nexport function t(): number { return idx() }\n",
        })

        const { threw, result } = await attempt(root)
        if (!threw) for (const e of result!.entries) expect(e.source ?? "").not.toBe("")
    }, 30_000)

    test("two files declaring the same ambient type name with DIFFERENT shapes", async () => {
        // The ambient pool is keyed by name and first-wins. Two different
        // `type Result` definitions would silently give one tool the other's
        // shape — a wrong scope that looks completely healthy.
        const { root } = await toolsDir({
            "a.ts": "type Result = { kind: 'a'; a: number }\nexport function a(): Result { return { kind: 'a', a: 1 } }\n",
            "b.ts": "type Result = { kind: 'b'; b: string }\nexport function b(): Result { return { kind: 'b', b: '' } }\n",
        })

        const { threw, result } = await attempt(root)
        if (threw) return

        // If both survive, each tool's carried type must match its own shape.
        const a = result!.entries.find(e => e.name === "a")
        const b = result!.entries.find(e => e.name === "b")
        const aTypes = (a?.ambientTypes ?? []).join("\n")
        const bTypes = (b?.ambientTypes ?? []).join("\n")
        if (aTypes.includes("kind: 'a'") && bTypes.includes("kind: 'b'")) return
        // Otherwise one tool was handed the other's type — that is the failure.
        expect(aTypes === bTypes ? "collided" : "distinct").toBe("distinct")
    }, 30_000)

    test("a tool file that throws at module scope still scans (execution is the capsule's problem)", async () => {
        const { root } = await toolsDir({ "t.ts": "throw new Error('boom at import')\nexport function f(): number { return 1 }\n" })

        const { threw, result } = await attempt(root)
        if (!threw) expect(result!.entries[0]?.source ?? "").not.toBe("")
    }, 30_000)

    test("a very large tool file", async () => {
        const many = Array.from({ length: 500 }, (_, i) => `export function f${i}(a: number): number { return a + ${i} }`).join("\n")
        const { root } = await toolsDir({ "big.ts": `${many}\n` })

        const { threw, result } = await attempt(root)
        if (!threw) expect(result!.entries[0]?.fns.length).toBe(500)
    }, 60_000)

    test("unicode and emoji in identifiers, JSDoc and string literals", async () => {
        const { root } = await toolsDir({
            "t.ts": "/** Grüße 🎲 — rolls the dice. */\nexport function würfeln(): string { return '🎲' }\n",
        })

        const { threw, result } = await attempt(root)
        if (!threw) for (const fn of result!.entries[0]?.fns ?? []) assertParses(fn.declaration)
    }, 30_000)

    test("a filename that is not a valid identifier", async () => {
        // The filename becomes the tool NAME. `my-tools.ts` is fine flat, but a
        // namespaced consumer would need `my-tools.fn` which does not parse.
        const { root } = await toolsDir({ "my-tools.ts": "export function f(): number { return 1 }\n" })

        const { threw, result } = await attempt(root)
        if (!threw) expect(result!.entries.map(e => e.name)).toContain("my-tools")
    }, 30_000)

    test("a symlinked tool file", async () => {
        const { root, dir } = await toolsDir({ "real.ts": "export function real(): number { return 1 }\n" })
        await symlink(join(dir, "real.ts"), join(dir, "linked.ts")).catch(() => {})

        const { threw, result } = await attempt(root)
        if (!threw) for (const e of result!.entries) expect(e.source ?? "").not.toBe("")
    }, 30_000)

    test("a tool importing node builtins and an npm dependency", async () => {
        const { root } = await toolsDir({
            "t.ts": "import { join } from 'node:path'\nexport function j(a: string): string { return join(a, 'x') }\n",
        })

        const { threw, result } = await attempt(root)
        if (!threw) expect(result!.entries[0]?.source ?? "").not.toBe("")
    }, 30_000)
})

// ─── Cache under abuse ───────────────────────────────────────────────────────

describe("adversarial: the cache cannot be made to serve a wrong answer", () => {
    test("a cache claiming the right hash but the wrong file set is rejected", async () => {
        // A hand-edited or half-written cache must not be trusted just because
        // its hash field matches.
        const { root } = await toolsDir({
            "a.ts": "export function a(): number { return 1 }\n",
            "b.ts": "export function b(): number { return 2 }\n",
        })
        const cold = await Tools(root)

        const cachePath = join(root, ".agent", "cache", "tools-declare-cache.json")
        const cached = JSON.parse(await Bun.file(cachePath).text())
        cached.files = cached.files.slice(0, 1) // drop one, keep the hash
        await writeFile(cachePath, JSON.stringify(cached))

        const after = await Tools(root)

        expect(after.entries.map(e => e.name).sort()).toEqual(cold.entries.map(e => e.name).sort())
    }, 60_000)

    test("an empty cache at a matching hash is rejected, not served", async () => {
        // The exact poisoned state the user had on disk.
        const { root } = await toolsDir({ "a.ts": "export function a(): number { return 1 }\n" })
        await Tools(root)

        const cachePath = join(root, ".agent", "cache", "tools-declare-cache.json")
        const cached = JSON.parse(await Bun.file(cachePath).text())
        await writeFile(cachePath, JSON.stringify({ inputHash: cached.inputHash, files: [] }))

        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(["a"])
    }, 60_000)

    test("a cache file that is a JSON array rather than an object", async () => {
        const { root } = await toolsDir({ "a.ts": "export function a(): number { return 1 }\n" })
        const cold = await Tools(root)

        await writeFile(join(root, ".agent", "cache", "tools-declare-cache.json"), "[]")
        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(cold.entries.map(e => e.name))
    }, 60_000)

    test("a cache file containing null", async () => {
        const { root } = await toolsDir({ "a.ts": "export function a(): number { return 1 }\n" })
        const cold = await Tools(root)

        await writeFile(join(root, ".agent", "cache", "tools-declare-cache.json"), "null")
        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(cold.entries.map(e => e.name))
    }, 60_000)

    test("an empty cache file", async () => {
        const { root } = await toolsDir({ "a.ts": "export function a(): number { return 1 }\n" })
        const cold = await Tools(root)

        await writeFile(join(root, ".agent", "cache", "tools-declare-cache.json"), "")
        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(cold.entries.map(e => e.name))
    }, 60_000)

    test("whitespace-only edits change the hash and rebuild rather than serving stale output", async () => {
        const { root, dir } = await toolsDir({ "a.ts": "export function a(): number { return 1 }\n" })
        await Tools(root)

        await writeFile(join(dir, "a.ts"), "export function a(): number { return 2 }\n")
        const after = await Tools(root)

        expect(after.entries[0]?.source).toContain("2")
    }, 60_000)

    test("two files whose contents are swapped invalidate correctly", async () => {
        // Content hash folds in the path, so swapping bodies between two files
        // must not hash to the same thing as before.
        const { root, dir } = await toolsDir({
            "a.ts": "export function a(): number { return 1 }\n",
            "b.ts": "export function b(): number { return 2 }\n",
        })
        await Tools(root)

        await writeFile(join(dir, "a.ts"), "export function b(): number { return 2 }\n")
        await writeFile(join(dir, "b.ts"), "export function a(): number { return 1 }\n")
        const after = await Tools(root)

        const aFns = after.entries.find(e => e.name === "a")?.fns.map(f => f.name)
        expect(aFns).toEqual(["b"])
    }, 60_000)
})
