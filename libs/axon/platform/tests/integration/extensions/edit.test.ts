import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addEntry, readEntries, removeEntry } from "@arcforge/platform/build/extensions"

/**
 * Editing `profile.config.ts`.
 *
 * This is the user's own file — comments, ordering, an entry they disabled by
 * hand. Every test here is really one assertion: that an install changes the
 * one line it must and nothing else. Regenerating the file from a parsed model
 * would pass a "the entry is there" test while silently discarding the rest,
 * which is why these compare whole-file output rather than parsed entries.
 *
 * The other half is that a botched edit costs a user their entire TUI config,
 * so a result that does not parse must never be written.
 */

async function withConfig(
    initial: string,
    fn: (ctx: { root: string; read: () => Promise<string> }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-edit-"))
    try {
        await writeFile(join(root, "profile.config.ts"), initial)
        await fn({ root, read: () => readFile(join(root, "profile.config.ts"), "utf-8") })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("profile.config.ts edits", () => {
    test("adds the first entry to an empty array", async () => {
        await withConfig(`export default defineProfile({
    extensions: [],
})
`, async ({ root, read }) => {
            expect(await addEntry(root, "@axon/vim")).toEqual({ changed: true })
            expect(await read()).toBe(`export default defineProfile({
    extensions: [
        "@axon/vim",
    ],
})
`)
        })
    })

    test("appends to a populated array, preserving comments and order", async () => {
        await withConfig(`export default defineProfile({
    // load order decides collisions
    extensions: [
        "@axon/vim",
        "./extensions/mine",
    ],
})
`, async ({ root, read }) => {
            await addEntry(root, "@axon/git")

            // Appended, never inserted: the array IS load order, so a new
            // extension goes last, where it loses every collision rather than
            // silently displacing something already installed.
            expect(await read()).toBe(`export default defineProfile({
    // load order decides collisions
    extensions: [
        "@axon/vim",
        "./extensions/mine",
        "@axon/git",
    ],
})
`)
        })
    })

    test("adds a missing trailing comma rather than producing two", async () => {
        await withConfig(`export default defineProfile({
    extensions: [
        "@axon/vim"
    ],
})
`, async ({ root, read }) => {
            await addEntry(root, "@axon/git")

            expect(await read()).toBe(`export default defineProfile({
    extensions: [
        "@axon/vim",
        "@axon/git",
    ],
})
`)
        })
    })

    test("matches the file's own indentation", async () => {
        await withConfig(`export default defineProfile({
  extensions: [
    "@axon/vim",
  ],
})
`, async ({ root, read }) => {
            await addEntry(root, "@axon/git")

            // Two-space, because that is what the file used. An edit should be
            // invisible in a diff beside the user's own formatting.
            expect(await read()).toContain(`    "@axon/vim",\n    "@axon/git",`)
        })
    })

    test("removes an entry from the middle without disturbing its neighbours", async () => {
        await withConfig(`export default defineProfile({
    extensions: [
        "@axon/vim",
        "@axon/git",
        "./extensions/mine",
    ],
})
`, async ({ root, read }) => {
            expect(await removeEntry(root, "@axon/git")).toEqual({ changed: true })
            expect(await read()).toBe(`export default defineProfile({
    extensions: [
        "@axon/vim",
        "./extensions/mine",
    ],
})
`)
        })
    })

    test("removes the object form, including a disabled entry", async () => {
        await withConfig(`export default defineProfile({
    extensions: [
        "@axon/vim",
        { source: "@axon/git", enabled: false },
    ],
})
`, async ({ root, read }) => {
            await removeEntry(root, "@axon/git")

            // Uninstalling is not disabling: leaving the husk behind would make
            // `axon ext list` show something that is not installed.
            expect(await read()).not.toContain("@axon/git")
            expect(await read()).toContain("@axon/vim")
        })
    })

    test("adding an entry that is already there changes nothing", async () => {
        await withConfig(`export default defineProfile({
    extensions: ["@axon/vim"],
})
`, async ({ root, read }) => {
            const before = await read()
            expect(await addEntry(root, "@axon/vim")).toEqual({ changed: false })
            expect(await read()).toBe(before)
        })
    })

    test("removing an entry that is not there changes nothing", async () => {
        await withConfig(`export default defineProfile({
    extensions: ["@axon/vim"],
})
`, async ({ root, read }) => {
            const before = await read()
            expect(await removeEntry(root, "@axon/nope")).toEqual({ changed: false })
            expect(await read()).toBe(before)
        })
    })

    test("reads the declared entries in order", async () => {
        await withConfig(`export default defineProfile({
    extensions: [
        "@axon/vim",
        { source: "@axon/git", enabled: false },
        "./extensions/mine",
    ],
})
`, async ({ root }) => {
            // Order matters and a disabled entry is still DECLARED — `list`
            // shows what the config says, not what happens to load.
            expect(await readEntries(root)).toEqual(["@axon/vim", "@axon/git", "./extensions/mine"])
        })
    })

    test("a config with no extensions array is refused, not rewritten", async () => {
        await withConfig(`export default defineProfile({})\n`, async ({ root, read }) => {
            const before = await read()

            // Nothing is written when the array cannot be found. Appending text
            // hopefully would risk a file the user wrote by hand.
            expect(addEntry(root, "@axon/vim")).rejects.toThrow()
            expect(await read()).toBe(before)
        })
    })

    test("every edit still parses", async () => {
        await withConfig(`export default defineProfile({
    extensions: [],
})
`, async ({ root, read }) => {
            await addEntry(root, "@axon/a")
            await addEntry(root, "@axon/b")
            await addEntry(root, "@axon/c")
            await removeEntry(root, "@axon/b")

            // Repeated edits compound, so the invariant has to hold across a
            // sequence rather than one call.
            expect(await readEntries(root)).toEqual(["@axon/a", "@axon/c"])
            expect(await read()).toContain("defineProfile({")
        })
    })

    test("emptying the array leaves it exactly as it was scaffolded", async () => {
        const scaffolded = `export default defineProfile({
    extensions: [],
})
`
        await withConfig(scaffolded, async ({ root, read }) => {
            // Install/uninstall is a cycle users repeat, so the edit has to be
            // reversible on the FILE, not merely on what readEntries() reports.
            // Each removal used to leave the indent its entry sat on behind, so
            // the array crept toward `[\n\n\n]` — valid, which is why the
            // parse-before-write check passed it, and steadily uglier in a file
            // whose whole purpose is being opened and edited by hand.
            for (let i = 0; i < 3; i++) {
                await addEntry(root, "@axon/round-trip")
                await removeEntry(root, "@axon/round-trip")
            }

            expect(await read()).toBe(scaffolded)
        })
    })

    test("removing the last entry does not disturb the entries left", async () => {
        await withConfig(`export default defineProfile({
    extensions: [],
})
`, async ({ root, read }) => {
            await addEntry(root, "@axon/a")
            await addEntry(root, "@axon/b")
            await removeEntry(root, "@axon/a")

            // The surviving entry keeps its own line and indent. An over-eager
            // whitespace sweep pulled the next entry up onto the bracket line,
            // which readEntries() cannot see and a human immediately does.
            expect(await read()).toBe(`export default defineProfile({
    extensions: [
        "@axon/b",
    ],
})
`)
        })
    })
})
