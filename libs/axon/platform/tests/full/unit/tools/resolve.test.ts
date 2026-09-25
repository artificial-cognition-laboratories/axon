import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { declareTools } from "@arcforge/platform/build/blueprint/scan/declare"

/**
 * Type resolution: what the author named, rendered so the model can read it.
 *
 * THE RULE. The author's declaration is the contract. A type they put in an
 * exported signature is inlined faithfully — this seam has no opinion on
 * whether the shape was a good idea, only on whether it can be rendered. It
 * fails when a name genuinely resolves to nothing, and at no other time.
 *
 * The gate this replaced enforced something quite different, and the difference
 * is what most of these tests pin. It matched text, so it could not see through
 * a re-export, a `Pick`, or an indexed access — and it never looked at an
 * unannotated signature at all, so the SAME external type passed or failed
 * depending only on whether the author wrote the annotation. It rewarded
 * deleting types, and the reward was a worse scope: an `import("pkg").T` the
 * model cannot resolve.
 *
 * The invariant underneath all of it: EVERY TYPE NAME THE MODEL READS RESOLVES
 * TO A DECLARATION IN THE SAME CONTEXT. A dangling name is the silent-wrong-
 * output failure this seam exists to prevent, and it is the one thing no case
 * below is allowed to produce.
 */

const roots: string[] = []
afterAll(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A project with the given files, keyed by path relative to the root. */
async function project(files: Record<string, string>): Promise<{ root: string; path: (rel: string) => string }> {
    const root = await mkdtemp(join(tmpdir(), "axon-resolve-"))
    roots.push(root)
    for (const [rel, source] of Object.entries(files)) {
        const full = join(root, rel)
        await mkdir(join(full, ".."), { recursive: true })
        await writeFile(full, source, "utf8")
    }
    return { root, path: (rel: string) => join(root, rel) }
}

/** The type names carried alongside a declared tool, sorted. */
function typeNames(ambient: string[]): string[] {
    return ambient
        .map(text => /(?:type|interface|class|enum)\s+(\w+)/.exec(text)?.[1])
        .filter((n): n is string => Boolean(n))
        .sort()
}

// ─── Types that live in another package ──────────────────────────────────────

describe("resolve: a type the author re-exports from a package travels with the tool", () => {
    /**
     * The reported failure, reduced to its shape.
     *
     * A module re-exported its SDK's response types exactly as the error
     * instructed, and the scanner rejected it anyway — the re-export emits
     * verbatim into the .d.ts and declares nothing locally, so a text-matching
     * resolver could not see it. The author was told to write the line their
     * source already had, and there was no edit that satisfied the gate.
     */
    test("an `export type { T } from` re-export resolves and inlines T", async () => {
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string; score: number }\n",
            "src/tools/t.ts":
                `export type { Hit } from "sdk"\n`
                + `import type { Hit } from "sdk"\n`
                + `export async function search(q: string): Promise<Hit[]> { return [] }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Hit"])
        expect(declared.ambientTypes.join("\n")).toContain("score")
    })

    test("a package type is inlined as its SHAPE, never as a module path", async () => {
        // `import("sdk").Hit` is not usable output: the model cannot resolve the
        // specifier, and the generated tool-globals.d.ts would need the package
        // on disk to compile.
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string }\nexport declare function go(): Promise<Hit>\n",
            "src/tools/t.ts":
                `export type { Hit } from "sdk"\n`
                + `import { go } from "sdk"\n`
                + `export async function search() { return go() }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(declared.fns[0]?.declaration).toContain("Promise<Hit>")
        expect(declared.fns[0]?.declaration).not.toContain("import(")
    })
})

// ─── Narrowing an external type ──────────────────────────────────────────────

describe("resolve: narrowing a package type is legal and resolves", () => {
    /**
     * Returning a SUBSET of a large SDK response is the shape worth
     * encouraging — the tool boundary is a serialization boundary, and a
     * hand-narrowed type is a better contract than a pass-through. The previous
     * gate rejected both spellings of it, because `Pick<Hit, "id">` and
     * `Hit["id"]` each keep the parent name in the emitted text with no local
     * declaration behind it. Authors were pushed toward hand-copying fields,
     * which desyncs on the next SDK bump — exactly what narrowing avoids.
     */
    test("Pick<T, …> of a package type resolves, carrying T", async () => {
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string; body: string; score: number }\n",
            "src/tools/t.ts":
                `import type { Hit } from "sdk"\n`
                + `export type Slim = Pick<Hit, "id" | "score">\n`
                + `export async function search(): Promise<Slim[]> { return [] }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Hit", "Slim"])
    })

    test("an indexed access into a package type resolves", async () => {
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string; meta: { tag: string } }\n",
            "src/tools/t.ts":
                `import type { Hit } from "sdk"\n`
                + `export async function tag(): Promise<Hit["meta"]> { return { tag: "" } }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Hit"])
    })
})

// ─── Transitive resolution ───────────────────────────────────────────────────

describe("resolve: a resolved type's own field types resolve too", () => {
    test("a nested type referenced by an inlined type is itself inlined", async () => {
        // Shipped broken before this: `Big` was inlined and `Deep` was not, so
        // the model read `b: Deep` with no Deep anywhere in its context. Nothing
        // failed — the scope simply described a type the model could not follow.
        const p = await project({
            "src/tools/t.ts":
                "export type Deep = { z: number }\n"
                + "export type Big = { a: string; b: Deep }\n"
                + "export async function f(): Promise<Big> { return null as never }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Big", "Deep"])
    })

    test("a self-referential type resolves once and terminates", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export type Node2 = { id: string; children: Node2[] }\n"
                + "export async function tree(): Promise<Node2> { return null as never }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Node2"])
    })

    test("mutually recursive types both resolve and terminate", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export type A = { b?: B }\n"
                + "export type B = { a?: A }\n"
                + "export async function f(): Promise<A> { return {} }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["A", "B"])
    })
})

// ─── Termination at lib types ────────────────────────────────────────────────

describe("resolve: TypeScript's own globals are leaves, never inlined", () => {
    /**
     * `Array` is declared across lib.es5, lib.es2015.core, lib.es2015.iterable
     * and more, merged into one symbol. A leaf test asking whether EVERY
     * declaration sits in a lib file answered false, and the walk inlined the
     * whole `interface Array<T>` — hundreds of lines of methods — into every
     * agent's context. The model already knows these types; their declarations
     * are pure cost.
     */
    test("a signature naming Array/Promise/Date carries no lib declarations", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export type Row = { at: Date; tags: string[] }\n"
                + "export async function rows(): Promise<Array<Row>> { return [] }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Row"])
        expect(declared.ambientTypes.join("\n")).not.toContain("interface Array")
        expect(declared.ambientTypes.join("\n")).not.toContain("interface Date")
    })

    test("a Record/Partial utility type does not drag lib declarations in", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export type Meta = { k: string }\n"
                + "export async function f(): Promise<Record<string, Partial<Meta>>> { return {} }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Meta"])
    })
})

// ─── The invariant: nothing dangles ──────────────────────────────────────────

describe("resolve: a name the model cannot resolve is never shipped", () => {
    test("a type that resolves to nothing throws, naming itself", async () => {
        const p = await project({
            "src/tools/t.ts":
                `import type { Missing } from "../lib/gone.ts"\n`
                + `export function f(o: Missing): string { return String(o) }\n`,
        })

        expect(() => declareTools([p.path("src/tools/t.ts")])).toThrow(/Missing/)
    })

    /**
     * The bypass that made the old gate advisory rather than enforced.
     *
     * An UNANNOTATED tool returning a package type used to pass, because tsc
     * emits `import("pkg").T` and no bare identifier ever appears for a text
     * matcher to catch. So annotating was punished and deleting the annotation
     * was rewarded — with a strictly worse scope, since the laundered form is
     * opaque to the model. Both spellings must now reach the same verdict.
     */
    test("an unannotated signature cannot launder an untravelled package type", async () => {
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string }\nexport declare function go(): Promise<Hit>\n",
            "src/tools/t.ts": `import { go } from "sdk"\nexport async function search() { return go() }\n`,
        })

        expect(() => declareTools([p.path("src/tools/t.ts")])).toThrow(/Hit/)
    })

    test("and re-exporting that type is a fix that actually works", async () => {
        // The other half of the case above: the error must name an edit that
        // resolves it. The old message prescribed a re-export the resolver could
        // not see, so following the instruction changed nothing.
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts": "export type Hit = { id: string }\nexport declare function go(): Promise<Hit>\n",
            "src/tools/t.ts":
                `export type { Hit } from "sdk"\n`
                + `import { go } from "sdk"\n`
                + `export async function search() { return go() }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Hit"])
    })

    test("a generic's own type parameter is not treated as a dangling type", async () => {
        // `T` is bound by the signature that carries it — resolvable without
        // being inlined, and a resolver that cannot tell the difference rejects
        // every generic tool in the registry.
        const p = await project({
            "src/tools/t.ts": "export async function id<T>(x: T): Promise<T> { return x }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(declared.ambientTypes).toEqual([])
    })
})

// ─── The author's declaration is the contract ────────────────────────────────

describe("resolve: the author decides what is exposed, not the scanner", () => {
    test("a raw package response type passes through when the author says so", async () => {
        // The design call this pins: passing an SDK type through is the author's
        // to make. Narrowing is better practice and stays a recommendation —
        // the scanner renders what it is given rather than refusing it.
        const p = await project({
            "node_modules/sdk/package.json": JSON.stringify({ name: "sdk", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/sdk/index.d.ts":
                "export type Inner = { n: number }\n"
                + "export type Big = { a: string; b: Inner; c: string[] }\n",
            "src/tools/t.ts":
                `export type { Big } from "sdk"\n`
                + `import type { Big } from "sdk"\n`
                + `export async function f(): Promise<Big> { return null as never }\n`,
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        // Inner comes along because Big names it — a partially-described type
        // would be worse than either extreme.
        expect(typeNames(declared.ambientTypes)).toEqual(["Big", "Inner"])
    })

    test("an interface's extends clause is followed", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export interface Base { id: string }\n"
                + "export interface Row extends Base { n: number }\n"
                + "export async function f(): Promise<Row> { return null as never }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Base", "Row"])
    })

    test("an enum used in a signature travels", async () => {
        const p = await project({
            "src/tools/t.ts":
                "export enum Status { Open = 'open', Shut = 'shut' }\n"
                + "export async function f(): Promise<Status> { return Status.Open }\n",
        })

        const declared = declareTools([p.path("src/tools/t.ts")]).get(p.path("src/tools/t.ts"))!

        expect(typeNames(declared.ambientTypes)).toEqual(["Status"])
    })
})
