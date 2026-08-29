import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSettings, setSetting } from "@arcforge/platform/build/extensions"

/**
 * `settings` in profile.config.ts — the one source of truth for a terminal.
 *
 * The property every test here defends: what a user READS in that file is what
 * is in effect. A sidecar store holding runtime overrides would make "why isn't
 * my config taking effect" a real question with a precedence rule for an
 * answer, so `:theme set` edits this file rather than shadowing it.
 *
 * Which means these edits land in a file a person also writes by hand — so an
 * edit has to be indistinguishable from one they made themselves. Formatting,
 * key order and everything around the change are all asserted, not just the
 * value that was set.
 */

const SCAFFOLD = `export default defineProfile({
    extensions: [
        "@cody/ember-theme",
    ],
})
`

async function withConfig(
    contents: string,
    fn: (ctx: { root: string; read: () => Promise<string> }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-settings-"))
    try {
        await writeFile(join(root, "profile.config.ts"), contents)
        await fn({ root, read: () => readFile(join(root, "profile.config.ts"), "utf-8") })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("profile settings", () => {
    test("creates the settings block beside extensions, not above it", async () => {
        await withConfig(SCAFFOLD, async ({ root, read }) => {
            await setSetting(root, "theme", "ember-theme")

            // Appended after the properties already there. A block inserted at
            // the top of a file the user has arranged reads as the tool
            // rearranging their config rather than adding to it.
            expect(await read()).toBe(`export default defineProfile({
    extensions: [
        "@cody/ember-theme",
    ],

    settings: {
        theme: "ember-theme",
    },
})
`)
        })
    })

    test("renders arrays and objects the way a person writes them", async () => {
        await withConfig(SCAFFOLD, async ({ root, read }) => {
            await setSetting(root, "paths", ["~/work", "~/oss"])
            await setSetting(root, "verbosity", { kernel: true })

            const text = await read()
            // Multi-line with trailing commas — a machine edit has to be
            // invisible in a diff beside the user's own formatting, and a
            // one-line JSON blob would not be.
            expect(text).toContain(`        paths: [
            "~/work",
            "~/oss",
        ],`)
            expect(text).toContain(`        verbosity: {
            kernel: true,
        },`)
        })
    })

    test("setting an existing key replaces it in place", async () => {
        await withConfig(SCAFFOLD, async ({ root, read }) => {
            await setSetting(root, "theme", "ember-theme")
            await setSetting(root, "paths", ["~/work"])
            await setSetting(root, "theme", "nord")

            const text = await read()
            // Replaced, not appended: two `theme:` keys is a config whose
            // meaning depends on which one a reader gets to first.
            expect(text.match(/theme:/g)).toHaveLength(1)
            expect(text).toContain(`theme: "nord"`)
            // And it keeps its position — a rewrite that moved the key to the
            // end would reorder the user's block on every change.
            expect(text.indexOf("theme:")).toBeLessThan(text.indexOf("paths:"))
        })
    })

    test("reads back exactly what was written", async () => {
        await withConfig(SCAFFOLD, async ({ root }) => {
            await setSetting(root, "theme", "nord")
            await setSetting(root, "paths", ["~/work", "~/oss"])
            await setSetting(root, "verbosity", { kernel: true, session: "verbose" })

            expect(await readSettings(root)).toEqual({
                theme: "nord",
                paths: ["~/work", "~/oss"],
                verbosity: { kernel: true, session: "verbose" },
            })
        })
    })

    test("setting a key to the value it already holds writes nothing", async () => {
        await withConfig(SCAFFOLD, async ({ root, read }) => {
            await setSetting(root, "theme", "nord")
            const before = await read()

            expect(await setSetting(root, "theme", "nord")).toEqual({ changed: false })

            // Byte-identical. This is what stops `:theme set` on the theme
            // already active from touching the file — and, once the watcher is
            // running, from triggering a reload for a no-op.
            expect(await read()).toBe(before)
        })
    })

    test("leaves comments and the user's own layout alone", async () => {
        const authored = `// my terminal
export default defineProfile({
    // load order matters
    extensions: [
        "@cody/ember-theme",
    ],

    settings: {
        // the good one
        theme: "ember-theme",
    },
})
`
        await withConfig(authored, async ({ root, read }) => {
            await setSetting(root, "paths", ["~/work"])

            const text = await read()
            // Every comment survives. This is the whole reason the edit is an
            // AST splice rather than a regenerate-from-model: a config carries
            // things a parsed representation would silently discard.
            expect(text).toContain("// my terminal")
            expect(text).toContain("// load order matters")
            expect(text).toContain("// the good one")
        })
    })

    test("an empty settings block accepts its first key", async () => {
        await withConfig(`export default defineProfile({
    extensions: [],
    settings: {},
})
`, async ({ root }) => {
            await setSetting(root, "theme", "nord")
            expect(await readSettings(root)).toEqual({ theme: "nord" })
        })
    })

    test("a config with no settings and no other keys still works", async () => {
        await withConfig(`export default defineProfile({})\n`, async ({ root }) => {
            await setSetting(root, "theme", "nord")
            expect(await readSettings(root)).toEqual({ theme: "nord" })
        })
    })

    test("reports an unparseable config rather than appending hopefully", async () => {
        await withConfig(`export const nothing = 1\n`, async ({ root }) => {
            // No defineProfile call to edit. Writing text at a guess would
            // damage a file the user wrote by hand, which is worse than saying
            // so and letting them add the line themselves.
            await expect(setSetting(root, "theme", "nord")).rejects.toMatchObject({
                code: "AX-EXT-026",
            })
        })
    })

    test("quotes a key that is not a valid identifier, and leaves plain ones bare", async () => {
        // Settings follow CSS where CSS has a name for the thing
        // ("padding-inline"). A hyphen is not valid in a bare property name, so
        // emitting one produced source that verified() correctly refused to
        // write — the setting could never be stored at all. Reading already
        // handled quoted keys; only writing did not.
        await withConfig(SCAFFOLD, async ({ root, read }) => {
            await setSetting(root, "padding-inline", 2)
            await setSetting(root, "theme", "nord")

            const text = await read()
            expect(text).toContain(`"padding-inline": 2,`)
            // A plain identifier must NOT gain quotes — every existing config
            // has bare keys, and quoting them would show up in a diff as churn.
            expect(text).toContain(`theme: "nord",`)

            expect(await readSettings(root)).toEqual({ "padding-inline": 2, theme: "nord" })
        })
    })

    test("reads an absent settings block as empty, not an error", async () => {
        await withConfig(SCAFFOLD, async ({ root }) => {
            expect(await readSettings(root)).toEqual({})
        })
    })
})
