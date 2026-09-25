import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DisposerSink, loadSource } from "@arcforge/platform/build/extensions/load"

/**
 * A reload must RE-EVALUATE every file, not be served a cached module.
 *
 * This is the test that was missing. `importFile` cache-busted with
 * `import(path + "?t=" + uuid)` — the Node idiom, which Bun ignores because it
 * keys its ESM cache on the resolved path and drops the query. So `reload()`
 * disposed every registration and then re-imported nothing: a reload silently
 * DESTROYED the user's commands, keybinds and themes, reporting no error
 * because nothing threw.
 *
 * Asserted by counting executions of the module body, which is the thing that
 * actually broke — a test that only checked "reload() resolved without error"
 * passed throughout.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function source(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-reload-"))
    roots.push(root)
    for (const [name, body] of Object.entries(files)) {
        const path = join(root, name)
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, body)
    }
    return root
}

const load = (root: string) =>
    loadSource({ root, label: "profile", sink: DisposerSink(), mainError: "PROFILE_MAIN_FAILED" })

describe("config reload re-evaluates", () => {
    test("main.ts runs again on every load", async () => {
        const root = await source({
            "main.ts": `(globalThis as any).__runs = ((globalThis as any).__runs ?? 0) + 1\n`,
        })
        const g = globalThis as Record<string, unknown>
        g.__runs = 0

        await load(root)
        expect(g.__runs).toBe(1)

        await load(root)
        expect(g.__runs).toBe(2)

        await load(root)
        expect(g.__runs).toBe(3)
    })

    test("a file's edits are visible on the next load", async () => {
        // The reason re-evaluation matters at all: a user saves their config
        // and expects the NEW text to run, not the copy imported at boot.
        const root = await source({ "main.ts": `(globalThis as any).__value = "first"\n` })
        const g = globalThis as Record<string, unknown>

        await load(root)
        expect(g.__value).toBe("first")

        await writeFile(join(root, "main.ts"), `(globalThis as any).__value = "second"\n`)
        await load(root)
        expect(g.__value).toBe("second")
    })

    test("a file importing a sibling still resolves it", async () => {
        // The transient copy is written BESIDE the original precisely so
        // relative specifiers keep resolving. A temp directory would break
        // every `./lib` import in a user's config.
        const root = await source({
            "sibling.ts": `export const VALUE = "from-sibling"\n`,
            "main.ts": `import { VALUE } from "./sibling"\n(globalThis as any).__sibling = VALUE\n`,
        })
        const g = globalThis as Record<string, unknown>

        const result = await load(root)
        expect(result.files[0]!.error).toBeNull()
        expect(g.__sibling).toBe("from-sibling")
    })

    test("plugins re-run too, and leave no copies behind", async () => {
        const root = await source({
            "main.ts": `(globalThis as any).__plugins = []\n`,
            "plugins/one.ts": `(globalThis as any).__plugins.push("one")\n`,
        })
        const g = globalThis as Record<string, unknown>

        await load(root)
        expect(g.__plugins).toEqual(["one"])

        await load(root)
        expect(g.__plugins).toEqual(["one"])

        // The copies are transient: one surviving would be imported as a
        // plugin on the next load, registering everything twice.
        const left = await readdir(join(root, "plugins"))
        expect(left).toEqual(["one.ts"])
        expect(await readdir(root)).toEqual(expect.arrayContaining(["main.ts", "plugins"]))
        expect((await readdir(root)).some(name => name.startsWith(".axon-reload-"))).toBe(false)
    })
})

/**
 * An error must name the file the USER wrote.
 *
 * Re-evaluation works by importing a transient copy, and that copy is deleted
 * immediately — so an unrewritten stack points at a path that no longer
 * exists, for a mistake in a file that does. Telling a user where their config
 * is broken is the entire value of these errors, so the path is the assertion.
 */
describe("config errors name the real file", () => {
    test("a throwing main.ts reports its own path, not the reload copy", async () => {
        const root = await source({ "main.ts": `throw new Error("kaboom")\n` })

        const result = await load(root)
        const failure = result.files[0]!.error as { cause?: Error } | null
        expect(failure).not.toBeNull()

        const stack = String(failure?.cause?.stack ?? "")
        expect(stack).toContain(join(root, "main.ts"))
        expect(stack).not.toContain(".axon-reload-")
    })

    test("an unresolvable import names the real file, not the copy", async () => {
        // The most common config mistake there is, and the one the first fix
        // missed: Bun reports it as a `ResolveMessage`, which is not an Error
        // and whose text ignores an assigned `.message`.
        const root = await source({ "main.ts": `import { X } from "./nope"\nconsole.log(X)\n` })

        const result = await load(root)
        const message = String((result.files[0]!.error as { message?: unknown } | null)?.message ?? "")
        expect(message).toContain(join(root, "main.ts"))
        expect(message).not.toContain(".axon-reload-")
    })

    test("a throwing plugin reports its own path too", async () => {
        const root = await source({
            "main.ts": `\n`,
            "plugins/broken.ts": `throw new Error("plugin boom")\n`,
        })

        const result = await load(root)
        const failure = result.files.find(file => file.error !== null)?.error as { cause?: Error } | undefined
        expect(failure).toBeDefined()

        const stack = String(failure?.cause?.stack ?? "")
        expect(stack).toContain(join(root, "plugins", "broken.ts"))
        expect(stack).not.toContain(".axon-reload-")
    })
})
