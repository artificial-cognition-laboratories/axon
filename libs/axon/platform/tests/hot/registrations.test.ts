import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeRegistrations, readRegistrations, scanSource } from "../../src/build/extensions/registrations"

/**
 * Reading a config's registrations without running it.
 *
 * What this has to get right is the LIMIT as much as the capability: only
 * literal names are knowable, and every union this feeds keeps a
 * `(string & {})` arm so a computed name still typechecks. A scanner that
 * quietly missed something would produce types that disagree with the runtime,
 * which is worse than no types at all.
 */

async function profile(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-reg-"))
    for (const [path, content] of Object.entries(files)) {
        const target = join(root, path)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, content)
    }
    return root
}

const names = (entries: readonly { name: string }[]) => entries.map(e => e.name)

describe("reading registrations", () => {
    test("finds each surface's create calls", async () => {
        const root = await profile({
            "main.ts": `
components.create("me:clock", { render: () => "x" })
lines.create("me:status", ["me:clock"])
palette.create("branches", { list: () => [] })
commands.register("hello", () => {})
`,
        })

        const found = scanSource(root)
        expect(names(found.components)).toEqual(["me:clock"])
        expect(names(found.lines)).toEqual(["me:status"])
        expect(names(found.palettes)).toEqual(["branches"])
        expect(names(found.commands)).toEqual(["hello"])
    })

    test("joins a command's path array the way the tree renders it", async () => {
        // `commands.run("git push")` is how a caller addresses it, so that is
        // the name a completion has to offer.
        const root = await profile({ "main.ts": `commands.register(["git", "push"], () => {})\n` })

        expect(names(scanSource(root).commands)).toEqual(["git push"])
    })

    test("carries the JSDoc above a registration", async () => {
        const root = await profile({
            "main.ts": `
/** Seconds since boot. */
components.create("me:uptime", { render: () => 1 })
`,
        })

        expect(scanSource(root).components[0]?.description).toBe("Seconds since boot.")
    })

    test("ignores a name that is not a literal", async () => {
        // Not a gap — the name is not knowable at generation time either, and
        // the open arm of every union is what keeps it legal.
        const root = await profile({
            "main.ts": `
const name = "me:computed"
components.create(name, { render: () => "x" })
components.create("me:literal", { render: () => "x" })
`,
        })

        expect(names(scanSource(root).components)).toEqual(["me:literal"])
    })

    test("reads plugins/ alongside main.ts, in load order", async () => {
        const root = await profile({
            "main.ts": `components.create("me:a", { render: () => "" })\n`,
            "plugins/b.ts": `components.create("me:b", { render: () => "" })\n`,
            "plugins/a.ts": `components.create("me:c", { render: () => "" })\n`,
        })

        // main first, then plugins alphabetically — the loader's own order.
        expect(names(scanSource(root).components)).toEqual(["me:a", "me:c", "me:b"])
    })

    test("a source with no code registers nothing rather than failing", async () => {
        // An extension may be all config: `profile.config.ts` and no main.ts.
        const root = await profile({ "profile.config.ts": `export default defineProfile({})\n` })

        expect(scanSource(root).components).toEqual([])
    })

    test("an unreadable file costs only itself", async () => {
        // Throwing would cost every OTHER source its types, for a failure the
        // loader already reports.
        expect(readRegistrations("/nonexistent/main.ts").components).toEqual([])
    })

    test("a syntactically broken file still yields what parsed", async () => {
        // A config being edited is broken half the time, and that is exactly
        // when completion matters most.
        const root = await profile({
            "main.ts": `
components.create("me:good", { render: () => "" })
lines.create("me:line", [
`,
        })

        expect(names(scanSource(root).components)).toEqual(["me:good"])
    })
})

describe("merging sources", () => {
    test("first registration wins a duplicate name", async () => {
        // The loader's own rule: a user's config loads before extensions, and
        // between extensions the earlier one in profile.config.ts keeps it.
        const merged = mergeRegistrations([
            { components: [{ name: "dup", description: "first" }], lines: [], palettes: [], commands: [] },
            { components: [{ name: "dup", description: "second" }], lines: [], palettes: [], commands: [] },
        ])

        expect(merged.components).toHaveLength(1)
        expect(merged.components[0]?.description).toBe("first")
    })

    test("keeps every distinct name across sources", async () => {
        const merged = mergeRegistrations([
            { components: [{ name: "a" }], lines: [], palettes: [], commands: [] },
            { components: [{ name: "b" }], lines: [], palettes: [], commands: [] },
        ])

        expect(names(merged.components)).toEqual(["a", "b"])
    })
})
