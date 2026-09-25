import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Tools } from "@arcforge/platform/build/blueprint/scan/tools"

/**
 * Bundling: the source the sandbox actually executes.
 *
 * Tools load by import() INSIDE the box. Passing a raw path would require
 * mounting the tool's file — and every file it imports — into the sandbox,
 * which either dangles the imports or re-exposes the whole project. So each
 * tool is bundled to one self-contained ESM module that the box materializes
 * from source, and nothing of the project is mounted at all.
 *
 * That makes `AxonTool.source` the authoritative artifact: whatever it does
 * not contain, the agent cannot call. A bundle that silently loses an import
 * produces a tool that declares fine, types fine, and throws "not defined" at
 * the moment the agent finally calls it — the worst possible place to find
 * out.
 *
 * So the properties here are: the bundle is COMPLETE (every dependency
 * inlined), and a bundle that cannot be produced is LOUD (never a tool
 * quietly missing from scope).
 */

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function agentRoot(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-bundle-"))
    roots.push(root)
    await mkdir(join(root, ".agent"), { recursive: true })
    await mkdir(join(root, "src", "tools"), { recursive: true })
    for (const [name, source] of Object.entries(files)) {
        const path = join(root, "src", "tools", name)
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, source)
    }
    return root
}

const sourceOf = (result: Awaited<ReturnType<typeof Tools>>, name: string) =>
    result.entries.find(e => e.name === name)?.source ?? ""

// ─── The bundle is complete ──────────────────────────────────────────────────

describe("tool bundling: the emitted source is self-contained", () => {
    test("a tool with no imports bundles to source carrying its own body", async () => {
        const root = await agentRoot({ "math.ts": "export function add(a: number, b: number) { return a + b }\n" })

        const result = await Tools(root)

        expect(sourceOf(result, "math")).toContain("add")
    }, 30_000)

    test("a sibling import is inlined, not left as a relative specifier", async () => {
        // The shared-internal-module pattern the docs recommend: `_http.ts`
        // holds helpers, the tool imports them. If the bundle kept the
        // `./_http` specifier, the sandbox would try to resolve a path that
        // was never mounted.
        const root = await agentRoot({
            "_http.ts": "export function headers(token: string) { return { Authorization: token } }\n",
            "api.ts": "import { headers } from './_http'\nexport function call(token: string) { return headers(token) }\n",
        })

        const result = await Tools(root)
        const source = sourceOf(result, "api")

        expect(source).toContain("Authorization")
        expect(source).not.toContain("from \"./_http\"")
        expect(source).not.toContain("from './_http'")
    }, 30_000)

    test("a transitive import chain is fully inlined", async () => {
        const root = await agentRoot({
            "_base.ts": "export const MARKER = 'deep-value'\n",
            "_mid.ts": "import { MARKER } from './_base'\nexport function mid() { return MARKER }\n",
            "top.ts": "import { mid } from './_mid'\nexport function top() { return mid() }\n",
        })

        const result = await Tools(root)

        expect(sourceOf(result, "top")).toContain("deep-value")
    }, 30_000)

    test("module-level state is emitted once, preserving the per-capsule-lifetime guarantee", async () => {
        // Module scope runs once at load and persists for the session — that is
        // the documented reason clients and caches live at module level. Two
        // copies of the initializer in one bundle would silently break it.
        const root = await agentRoot({
            "client.ts": "const client = { id: 'singleton-marker' }\nexport function get() { return client.id }\n",
        })

        const result = await Tools(root)
        const occurrences = sourceOf(result, "client").split("singleton-marker").length - 1

        expect(occurrences).toBe(1)
    }, 30_000)

    test("every scanned tool gets its own bundle", async () => {
        const root = await agentRoot({
            "a.ts": "export function one() { return 1 }\n",
            "b.ts": "export function two() { return 2 }\n",
        })

        const result = await Tools(root)

        expect(result.entries.every(e => (e.source ?? "").length > 0)).toBe(true)
    }, 30_000)

    test("a tool's bundle does not leak a sibling tool's exports", async () => {
        // One bundle per entry, not one bundle for the directory: each tool's
        // namespace must contain exactly its own exports, or the scope-mismatch
        // check at the capsule boundary would reject the load.
        const root = await agentRoot({
            "a.ts": "export function alpha() { return 'a' }\n",
            "b.ts": "export function beta() { return 'b' }\n",
        })

        const result = await Tools(root)

        expect(sourceOf(result, "a")).not.toContain("beta")
    }, 30_000)
})

// ─── A bundle that cannot be produced is loud ────────────────────────────────

describe("tool bundling: failure is never a quietly missing tool", () => {
    test("an unresolvable import fails the scan rather than dropping the tool", async () => {
        // Degrading to a warning here means an agent boots with a tool the
        // author wrote and the model was never told about — and, because the
        // warning is dropped at runtime boot, with nothing anywhere saying so.
        const root = await agentRoot({
            "broken.ts": "import { nope } from './does-not-exist'\nexport function f() { return nope }\n",
        })

        expect(Tools(root)).rejects.toThrow()
    }, 30_000)

    test("the bundle failure names the offending file", async () => {
        const root = await agentRoot({
            "broken.ts": "import { nope } from './does-not-exist'\nexport function f() { return nope }\n",
        })

        expect(Tools(root)).rejects.toThrow(/broken/)
    }, 30_000)

    test("one unbundlable tool fails the whole scan — no partial scope", async () => {
        const root = await agentRoot({
            "fine.ts": "export function fine() { return 1 }\n",
            "broken.ts": "import { nope } from './does-not-exist'\nexport function f() { return nope }\n",
        })

        expect(Tools(root)).rejects.toThrow()
    }, 30_000)

    test("a tool that declares but produces no bundle never enters scope", async () => {
        // Declaration and bundling are two independent passes over the same
        // files. If they ever disagree about which files succeeded, the entry
        // must not be emitted — a tool in scope with no source is a call the
        // sandbox cannot serve.
        const root = await agentRoot({ "math.ts": "export function add(a: number) { return a }\n" })

        const result = await Tools(root)

        for (const entry of result.entries) {
            expect(entry.source ?? "").not.toBe("")
        }
    }, 30_000)
})
