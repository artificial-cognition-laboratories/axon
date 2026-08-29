import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import ts from "typescript"
import { declareTools } from "@arcforge/platform/build/blueprint/scan/declare"

/**
 * The compiler seam: source in, the agent's declared scope out.
 *
 * Two properties, and every test here pins one of them.
 *
 * 1. INVALID INPUT IS LOUD. There is no graceful degradation of a tool
 *    that will not compile — a tool the author wrote and the agent cannot
 *    call means the agent's scope is not what was declared, which is an
 *    invalid state, not a warning. This seam used to answer a lookup miss
 *    with `continue`, producing `{ ok: true, files: [] }` — a SUCCESSFUL
 *    empty result, which the caller then cached against the source hash.
 *    Every subsequent boot hit that cache, so the agent had zero tools
 *    permanently and nothing anywhere said why.
 *
 * 2. WHAT IS DECLARED IS WHAT IS CALLABLE. The capsule wraps every tool in
 *    an async mediation wrapper (see capsule/process/scope.ts), so the
 *    value the agent actually holds returns a Promise whatever the author
 *    wrote. A declaration that says otherwise is a lie the model acts on:
 *    told `add(a, b): number`, it writes `add(1, 2) * 2` and silently gets
 *    NaN. And a signature naming a type whose definition never travels
 *    with it leaves the model reading a name it cannot resolve.
 */

const roots: string[] = []
// Swept once at the end, not per test: a batched fixture is built in beforeAll
// and read by every test in its describe, so a per-test sweep would delete the
// directory out from under them. Each root is a fresh mkdtemp, so no test ever
// depended on a previous one's files being gone.
afterAll(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A tools dir with the given files. Returns absolute paths in the order named. */
async function toolsDir(files: Record<string, string>): Promise<{ dir: string; paths: string[] }> {
    const root = await mkdtemp(join(tmpdir(), "axon-declare-"))
    roots.push(root)
    const dir = join(root, "src", "tools")
    await mkdir(dir, { recursive: true })
    const paths: string[] = []
    for (const [name, source] of Object.entries(files)) {
        const path = join(dir, name)
        await writeFile(path, source)
        paths.push(path)
    }
    return { dir, paths }
}

// ─── 1. Invalid input is loud ────────────────────────────────────────────────

describe("declareTools(): an invalid input never yields an empty success", () => {
    test("a non-normalized input path declares the tool rather than silently dropping it", async () => {
        // The reported bug, reduced. tsc normalizes paths internally and calls
        // writeFile with the normalized form; a lookup keyed on the raw input
        // then missed, and the file was dropped from the result — a SUCCESSFUL
        // empty declaration set, which the caller then cached against the
        // source hash. Nothing about this is Windows-specific ("/a/./b.ts"
        // reproduces it on any platform) but it is why an agent whose tool
        // paths carried backslashes saw toolCount: 0 while its bundle cache
        // held the tool perfectly.
        //
        // Resolving is the right answer here, not throwing: the path names a
        // real file and the author did nothing wrong. What must never happen is
        // the silent drop.
        const { dir } = await toolsDir({ "add.ts": "export function add(a: number, b: number) { return a + b }\n" })
        const denormalized = join(dir, ".", "add.ts").replace(`${dir}`, `${dir}/.`)

        const declared = declareTools([denormalized])

        expect(declared.get(denormalized)?.fns.map(f => f.name)).toEqual(["add"])
    })

    test("a file that does not exist throws", async () => {
        const { dir } = await toolsDir({})
        expect(() => declareTools([join(dir, "nope.ts")])).toThrow()
    })

    test("the failure names the offending file", async () => {
        // A scan spanning an agent's own src/tools and several installed
        // modules fails the same way for all of them; without the filename the
        // message cannot tell you which tool to go and fix.
        const { dir } = await toolsDir({})
        const missing = join(dir, "ghost.ts")

        expect(() => declareTools([missing])).toThrow(/ghost\.ts/)
    })

    test("one unresolvable file fails the whole call — no partial scope", async () => {
        // Half a scope is not a lesser success. If `broken` cannot be declared,
        // an agent booted against the remaining tools is not the agent the
        // author wrote.
        const { dir, paths } = await toolsDir({
            "fine.ts": "export function fine(a: number) { return a }\n",
        })

        expect(() => declareTools([paths[0]!, join(dir, "broken.ts")])).toThrow()
    })

    test("a signature referencing a type that resolves to nothing throws", async () => {
        // The silent-drop path: importedTypeNames() collects the referenced
        // name, the ambient pool has no declaration for it, and a filter
        // discards it — leaving the model a bare identifier with no definition.
        // Better to fail than to hand over an unresolvable scope.
        const { paths } = await toolsDir({
            "t.ts": "import type { Absent } from './nowhere'\nexport function get(): Absent { return null as never }\n",
        })

        expect(() => declareTools(paths)).toThrow()
    })
})

// ─── 2. What is declared is what is callable ─────────────────────────────────

describe("declareTools(): declarations describe the wrapped, callable value", () => {
    /**
     * These cases are independent single-file declarations, so they share ONE
     * ts.Program instead of building one each.
     *
     * ts.createProgram() is ~700ms of fixed cost (compiler host + lib.d.ts +
     * checker) and ~20ms of marginal cost per tool file, so a program per test
     * paid the entry fee eleven times to compile eleven small files. Measured:
     * 1 file 986ms, 12 files in one call 740ms, 12 files in twelve calls 5943ms.
     *
     * It is also closer to production, where an agent's whole src/tools/ is one
     * program (see declare.ts). Each case keeps its own FILE, so ES module
     * scoping keeps them independent — `math.ts` and `t.ts` cannot see each
     * other's symbols. Cases needing a directory shape of their own (a class in
     * src/lib/, a type shared across siblings) stay on their own root below.
     */
    const CASES = {
        "sync.ts": "export function add(a: number, b: number) { return a + b }\n",
        "parses.ts": "export function add(a: number, b: number) { return a + b }\nexport function greet(name: string): string { return name }\n",
        "async.ts": "export async function addAsync(a: number, b: number) { return a + b }\n",
        "void.ts": "export function ping(): void {}\n",
        "inferred.ts": "export function name() { return 'axon' }\n",
        "alias.ts": "type Task = { id: string; done: boolean }\nexport function next(): Task | null { return null }\n",
        "class.ts": "export class Roll {\n  total: number = 0\n}\nexport function roll(): Roll { return new Roll() }\n",
        "jsdoc.ts": "/** Search the tracker. Returns at most 20 results. */\nexport function search(q: string) { return [q] }\n",
        "multi.ts": "export function add(a: number) { return a }\nexport function sub(a: number) { return a }\n",
    } as const

    let declared: ReturnType<typeof declareTools>
    let dir: string
    /** The declared file for one case, by its filename in the shared program. */
    const at = (file: keyof typeof CASES) => declared.get(join(dir, file))

    beforeAll(async () => {
        const built = await toolsDir(CASES)
        dir = built.dir
        declared = declareTools(built.paths)
    })

    test("a sync tool is declared async — the capsule's wrapper is what the agent holds", () => {
        // Authors may write sync bodies; mediation makes every call async, so
        // the agent is told Promise<number>. Told `number` instead, a model
        // writes `add(1, 2) * 2` and gets NaN with no error anywhere.
        //
        // Asserted as an exact string, not a substring: lifting the return type
        // rewrites the declaration, and a rewrite that leaves a stray character
        // or eats a space still "contains" Promise<number> while emitting
        // TypeScript that does not parse.
        expect(at("sync.ts")?.fns[0]?.declaration).toBe("function add(a: number, b: number): Promise<number>")
    })

    test("the lifted declaration is valid TypeScript", () => {
        // The guard the substring assertions could not give us: parse what we
        // emit. `function add(a: number, b: number):Promise<number>r` satisfied
        // every toContain() check in this file and was syntactically broken.
        for (const fn of at("parses.ts")?.fns ?? []) {
            const source = ts.createSourceFile("t.d.ts", `declare ${fn.declaration};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            const diagnostics = (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics
            expect(diagnostics).toHaveLength(0)
        }
    })

    test("an async tool is declared Promise<T>, not Promise<Promise<T>>", () => {
        const decl = at("async.ts")?.fns[0]?.declaration ?? ""

        expect(decl).toContain("Promise<number>")
        expect(decl).not.toContain("Promise<Promise<")
    })

    test("a void tool is declared Promise<void>", () => {
        expect(at("void.ts")?.fns[0]?.declaration).toContain("Promise<void>")
    })

    test("return types are the compiler's real inference, never unknown", () => {
        // The reason this seam runs real declaration emission instead of AST
        // pattern matching: an unannotated return must still resolve.
        expect(at("inferred.ts")?.fns[0]?.declaration).toContain("Promise<string>")
    })

    test("a referenced type alias travels with the tool", () => {
        expect(at("alias.ts")?.ambientTypes.join("\n")).toContain("Task")
    })

    test("a referenced CLASS travels with the tool", () => {
        // Interfaces and type aliases were collected into the ambient pool;
        // class declarations were not, so a tool returning one showed the model
        // the class NAME with no definition behind it. Reported by a user whose
        // tools returned a `Roll` class from their own lib/.
        const carried = [
            ...(at("class.ts")?.ambientTypes ?? []),
            ...(at("class.ts")?.fns ?? []).map(f => f.declaration),
        ].join("\n")

        expect(carried).toContain("class Roll")
        expect(carried).toContain("total")
    })

    test("a class imported from outside src/tools travels too", async () => {
        // The user's actual shape: the class lives in the project's lib/, not
        // beside the tool.
        const root = await mkdtemp(join(tmpdir(), "axon-declare-"))
        roots.push(root)
        await mkdir(join(root, "src", "lib"), { recursive: true })
        await mkdir(join(root, "src", "tools"), { recursive: true })
        await writeFile(join(root, "src", "lib", "roll.ts"), "export class Roll {\n  total: number = 0\n}\n")
        const toolPath = join(root, "src", "tools", "dice.ts")
        await writeFile(toolPath, "import { Roll } from '../lib/roll'\nexport function roll(): Roll { return new Roll() }\n")

        const declared = declareTools([toolPath])
        const carried = (declared.get(toolPath)?.ambientTypes ?? []).join("\n")

        expect(carried).toContain("class Roll")
    })

    test("a type shared between sibling tool files resolves for both", async () => {
        // One ts.Program per directory exists for exactly this: a tool
        // importing a sibling's type needs the checker to see the whole set.
        const { paths } = await toolsDir({
            "shared.ts": "export type Item = { id: string }\n",
            "a.ts": "import type { Item } from './shared'\nexport function one(): Item { return { id: 'x' } }\n",
        })

        const declared = declareTools(paths)

        expect(declared.get(paths[1]!)?.ambientTypes.join("\n")).toContain("Item")
    })

    test("JSDoc is carried verbatim — it is the model's documentation", () => {
        expect(at("jsdoc.ts")?.fns[0]?.jsdoc).toContain("Search the tracker")
    })

    test("every exported function in a file is declared", () => {
        expect(at("multi.ts")?.fns.map(f => f.name).sort()).toEqual(["add", "sub"])
    })
})
