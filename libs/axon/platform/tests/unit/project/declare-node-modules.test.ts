import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { declareTools } from "@arcforge/platform/build/blueprint/scan/declare"

/**
 * Declaring tool source that lives inside `node_modules`.
 *
 * THE BUG: TypeScript treats anything under `node_modules` as external library
 * code and SILENTLY SKIPS declaration emit for it. Correct for a package that
 * ships its own `.d.ts`; exactly wrong for an Axon module, which ships
 * TypeScript source the consumer's scanner must declare to build the tool
 * scope.
 *
 * The failure was quiet and blamed the wrong person. A tool file importing a
 * sibling got one `.d.ts` where it needed two, every type declared in that
 * sibling became unresolvable, and the scanner told the author to re-export a
 * type their source already re-exported — @axon/arxiv shipped twice that way
 * and failed on every install.
 *
 * The tell was that byte-identical files gave different answers depending only
 * on their path, which is what these tests pin: the SAME source must declare
 * identically inside and outside node_modules.
 */

/** A module whose tool file imports types from a sibling — the shape that broke. */
async function moduleAt(base: string) {
    const tools = join(base, "src", "tools")
    const lib = join(base, "src", "lib")
    await mkdir(tools, { recursive: true })
    await mkdir(lib, { recursive: true })

    await writeFile(
        join(lib, "client.ts"),
        `export type QueryOptions = { limit?: number }\n`
        + `export type Paper = { id: string }\n`
        + `export async function go(o: QueryOptions = {}): Promise<Paper[]> { return [{ id: String(o.limit ?? 0) }] }\n`,
        "utf8",
    )
    await writeFile(
        join(tools, "probe.ts"),
        `import { go } from "../lib/client.ts"\n`
        + `import type { QueryOptions } from "../lib/client.ts"\n`
        + `export type { Paper, QueryOptions } from "../lib/client.ts"\n`
        + `export const probe = {\n`
        + `    async search(opts: QueryOptions = {}) { return go(opts) },\n`
        + `}\n`,
        "utf8",
    )
    return join(tools, "probe.ts")
}

async function scratch() {
    const root = await mkdtemp(join(tmpdir(), "axon-declare-nm-"))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const typeNames = (decls: string[]) =>
    decls.map(text => /(?:type|interface)\s+(\w+)/.exec(text)?.[1]).filter(Boolean).sort()

describe("declareTools inside node_modules", () => {
    test("resolves a type imported from a sibling file", async () => {
        // The exact @axon/arxiv failure. Before the fix this threw
        // `type "QueryOptions" is used in an exported signature but has no
        // resolvable definition`.
        const s = await scratch()
        try {
            const entry = await moduleAt(join(s.root, "node_modules", "@t", "mod"))
            const declared = declareTools([entry])

            expect(declared.size).toBe(1)
            const file = [...declared.values()][0]!
            expect(file.fns.map(fn => fn.name)).toEqual(["probe"])
            expect(typeNames(file.ambientTypes)).toEqual(["Paper", "QueryOptions"])
        } finally { await s.cleanup() }
    }, 60_000)

    test("declares IDENTICALLY inside and outside node_modules", async () => {
        // The property that makes the fix a fix rather than a workaround: the
        // path a file happens to sit at must not change what it declares.
        const s = await scratch()
        try {
            const inside = await moduleAt(join(s.root, "node_modules", "@t", "mod"))
            const outside = await moduleAt(join(s.root, "plain", "mod"))

            const a = [...declareTools([inside]).values()][0]!
            const b = [...declareTools([outside]).values()][0]!

            expect(a.fns.map(fn => fn.name)).toEqual(b.fns.map(fn => fn.name))
            expect(typeNames(a.ambientTypes)).toEqual(typeNames(b.ambientTypes))
        } finally { await s.cleanup() }
    }, 60_000)

    test("keys its result by the REAL path, not the internal rewrite", async () => {
        // The rewrite is an implementation detail of getting tsc to emit. A
        // caller that saw `__axon_modules__` in a result would be unable to
        // match it against the file list it passed in.
        const s = await scratch()
        try {
            const entry = await moduleAt(join(s.root, "node_modules", "@t", "mod"))
            const declared = declareTools([entry])

            const keys = [...declared.keys()]
            expect(keys.some(key => key.includes("__axon_modules__"))).toBe(false)
            expect(keys.some(key => key.includes("/node_modules/"))).toBe(true)
        } finally { await s.cleanup() }
    }, 60_000)

    test("still reports a genuinely missing type", async () => {
        // The fix must not make the scanner credulous: a type that really has
        // no definition is still an error, and still names itself.
        const s = await scratch()
        try {
            const tools = join(s.root, "node_modules", "@t", "broken", "src", "tools")
            await mkdir(tools, { recursive: true })
            await writeFile(
                join(tools, "broken.ts"),
                `import type { Missing } from "../lib/gone.ts"\n`
                + `export function search(opts: Missing): string { return String(opts) }\n`,
                "utf8",
            )

            expect(() => declareTools([join(tools, "broken.ts")])).toThrow()
        } finally { await s.cleanup() }
    }, 60_000)

    test("handles a path containing node_modules more than once", async () => {
        // A nested dependency tree does this routinely, and a naive
        // replace-first would rewrite one segment and leave the other.
        const s = await scratch()
        try {
            const entry = await moduleAt(
                join(s.root, "node_modules", "@t", "outer", "node_modules", "@t", "inner"),
            )
            const declared = declareTools([entry])
            expect(typeNames([...declared.values()][0]!.ambientTypes)).toEqual(["Paper", "QueryOptions"])
        } finally { await s.cleanup() }
    }, 60_000)
})
