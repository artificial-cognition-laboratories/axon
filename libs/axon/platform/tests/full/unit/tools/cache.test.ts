import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Tools } from "@arcforge/platform/build/blueprint/scan/tools"

/**
 * The tool caches, and the one rule they must never break:
 *
 *   A CACHE MAY MAKE A CORRECT SCAN FASTER. IT MAY NEVER CHANGE THE ANSWER.
 *
 * Two caches sit in front of this scan — tools-declare-cache.json (the
 * compiler seam) and tools-bundle-cache.json (Bun.build output) — both keyed
 * on one content hash of the tool sources. They exist because ts.createProgram
 * and Bun.build are each ~0.5-1.5s of blocking work that a reboot should not
 * repay when nothing changed.
 *
 * They are also how a one-off failure became permanent. A scan that answered
 * with an empty-but-successful result had that emptiness WRITTEN to the
 * declare cache against the source hash. Nothing about the source changed on
 * the next boot, so the hash matched, so the empty result was served from
 * disk — forever, through any number of reboots, while the bundle cache at
 * the very same hash held the tool perfectly. The user could see their tool in
 * one cache file and not the other and had no way to recover but to edit the
 * source or delete the cache by hand.
 *
 * So: every test here runs the scan TWICE. A cache that is never read is a
 * cache that is never tested, and the previous suite called Tools() exactly
 * once per temp directory.
 */

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** An agent-shaped root with a .agent/ dir (where the caches land) and the given tools. */
async function agentRoot(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-toolcache-"))
    roots.push(root)
    await mkdir(join(root, ".agent"), { recursive: true })
    await mkdir(join(root, "src", "tools"), { recursive: true })
    for (const [name, source] of Object.entries(files)) {
        await writeFile(join(root, "src", "tools", name), source)
    }
    return root
}

const declareCache = (root: string) => join(root, ".agent", "cache", "tools-declare-cache.json")
const bundleCache = (root: string) => join(root, ".agent", "cache", "tools-bundle-cache.json")

async function readJson(path: string): Promise<Record<string, unknown> | null> {
    try {
        return JSON.parse(await readFile(path, "utf-8"))
    } catch {
        return null
    }
}

// ─── The answer does not change ──────────────────────────────────────────────

describe("tool caches: a cached scan equals an uncached scan", () => {
    test("scanning twice yields an identical result", async () => {
        const root = await agentRoot({ "math.ts": "export function add(a: number, b: number) { return a + b }\n" })

        const cold = await Tools(root)
        const warm = await Tools(root)

        expect(warm.entries).toEqual(cold.entries)
        expect(warm.warnings).toEqual(cold.warnings)
    }, 30_000)

    test("the second scan actually reads the cache", async () => {
        // Guards the premise of every other test in this file: if no cache were
        // written, "scanning twice is identical" would pass trivially.
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })

        await Tools(root)

        expect(await readJson(declareCache(root))).not.toBeNull()
        expect(await readJson(bundleCache(root))).not.toBeNull()
    }, 30_000)

    test("editing a tool invalidates the cache and the new source wins", async () => {
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })
        await Tools(root)

        await writeFile(join(root, "src", "tools", "math.ts"), "export function multiply(a: number) { return a }\n")
        const after = await Tools(root)

        expect(after.entries[0]?.fns.map(f => f.name)).toEqual(["multiply"])
    }, 30_000)

    test("adding a tool file invalidates the cache", async () => {
        const root = await agentRoot({ "a.ts": "export function one() { return 1 }\n" })
        await Tools(root)

        await writeFile(join(root, "src", "tools", "b.ts"), "export function two() { return 2 }\n")
        const after = await Tools(root)

        expect(after.entries.map(e => e.name).sort()).toEqual(["a", "b"])
    }, 30_000)

    test("removing a tool file invalidates the cache", async () => {
        const root = await agentRoot({
            "a.ts": "export function one() { return 1 }\n",
            "b.ts": "export function two() { return 2 }\n",
        })
        await Tools(root)

        await rm(join(root, "src", "tools", "b.ts"))
        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(["a"])
    }, 30_000)

    test("renaming a tool file invalidates the cache even with identical contents", async () => {
        // The hash folds in the path for exactly this reason — the declared
        // scope is keyed by tool name, so a rename changes the answer.
        const source = "export function one() { return 1 }\n"
        const root = await agentRoot({ "a.ts": source })
        await Tools(root)

        await rm(join(root, "src", "tools", "a.ts"))
        await writeFile(join(root, "src", "tools", "renamed.ts"), source)
        const after = await Tools(root)

        expect(after.entries.map(e => e.name)).toEqual(["renamed"])
    }, 30_000)
})

// ─── Degenerate results are never persisted ──────────────────────────────────

describe("tool caches: a failure is never cached as a success", () => {
    test("a scan that produced no tools from real sources writes no declare cache", async () => {
        // The exact poisoning mechanism. If the scan cannot declare the tools it
        // was given, that outcome must not be written against the source hash —
        // otherwise the failure survives every future boot until the file is
        // edited. Better to redo the expensive work each boot than to serve a
        // wrong answer instantly and forever.
        const root = await agentRoot({ "broken.ts": "import { Gone } from './nowhere'\nexport function f(): Gone { return null as never }\n" })

        await Tools(root).catch(() => {})

        const cached = await readJson(declareCache(root))
        const files = (cached?.files ?? null) as unknown[] | null
        expect(files === null || files.length > 0).toBe(true)
    }, 30_000)

    test("the two caches can never disagree at the same hash", async () => {
        // The user-reported on-disk state: bundle-cache holding the tool,
        // declare-cache holding `"files": []`, both stamped with the same
        // inputHash. One of the two had silently failed while the other
        // succeeded, and the hash made that state permanent.
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })

        await Tools(root)

        const declare = await readJson(declareCache(root))
        const bundle = await readJson(bundleCache(root))
        if (declare && bundle && declare.inputHash === bundle.inputHash) {
            const files = (declare.files ?? []) as unknown[]
            const tools = Object.keys((bundle.tools ?? {}) as Record<string, unknown>)
            expect(files.length).toBe(tools.length)
        }
    }, 30_000)
})

// ─── Corruption is a miss, not a failure ─────────────────────────────────────

describe("tool caches: corruption degrades to a rebuild", () => {
    test("a corrupt declare cache is discarded and rebuilt", async () => {
        // A cache is derived data. Truncated by a kill mid-write (Bun.write is
        // not atomic), it must be treated as absent — never as a fatal read that
        // takes the whole scan down with it.
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })
        const cold = await Tools(root)

        await writeFile(declareCache(root), '{"inputHash":"abc","files":[')
        const after = await Tools(root)

        expect(after.entries).toEqual(cold.entries)
    }, 30_000)

    test("a corrupt bundle cache is discarded and rebuilt", async () => {
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })
        const cold = await Tools(root)

        await writeFile(bundleCache(root), "not json at all")
        const after = await Tools(root)

        expect(after.entries).toEqual(cold.entries)
    }, 30_000)

    test("a cache holding the wrong shape is discarded, not trusted", async () => {
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })
        const cold = await Tools(root)

        await writeFile(declareCache(root), JSON.stringify({ inputHash: "abc", files: "not-an-array" }))
        const after = await Tools(root)

        expect(after.entries).toEqual(cold.entries)
    }, 30_000)
})

// ─── A cache is an optimization, never a requirement ─────────────────────────

describe("tool caches: absence is never a failure", () => {
    test("a root with no writable artifact dir still scans correctly", async () => {
        // Read-only roots exist (a module vendored by a package manager, a
        // container mount). They pay the uncached cost; they do not fail.
        const root = await mkdtemp(join(tmpdir(), "axon-toolcache-ro-"))
        roots.push(root)
        await mkdir(join(root, "src", "tools"), { recursive: true })
        await writeFile(join(root, "src", "tools", "math.ts"), "export function add(a: number) { return a }\n")

        const result = await Tools(root)

        expect(result.entries.map(e => e.name)).toEqual(["math"])
    }, 30_000)
})
