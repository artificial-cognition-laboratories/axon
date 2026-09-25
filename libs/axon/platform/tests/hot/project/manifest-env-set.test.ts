import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"

/**
 * Setting a variable in an agent's own .env — what `:key set` writes.
 *
 * The file belongs to the user, so the test that matters most is that a write
 * leaves everything it did not touch alone: comments, grouping, and the
 * positions of existing keys are how a person navigates their own .env, and
 * re-serialising a parsed object would silently discard all of it.
 */

async function withRoot<T>(run: (root: string) => Promise<T>, seed?: string): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-env-set-test-"))
    try {
        if (seed !== undefined) await writeFile(join(root, ".env"), seed)
        return await run(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const read = (root: string) => readFile(join(root, ".env"), "utf-8")

describe("env.set: writing a key", () => {
    test("creates .env when the agent has none", async () => {
        await withRoot(async root => {
            await Manifest({ root }).env.set("TELEGRAM_BOT_TOKEN", "123:ABC")

            expect(await read(root)).toBe("TELEGRAM_BOT_TOKEN=123:ABC\n")
        })
    })

    test("round-trips through the parser", async () => {
        await withRoot(async root => {
            const manifest = Manifest({ root })
            await manifest.env.set("TOKEN", "hunter2")

            expect(manifest.env.parse(await read(root))).toEqual({ TOKEN: "hunter2" })
        })
    })

    test("replaces a key in place, preserving comments and order", async () => {
        const seed = [
            "# telegram",
            "TELEGRAM_BOT_TOKEN=old",
            "",
            "# other",
            "OTHER=untouched",
            "",
        ].join("\n")

        await withRoot(async root => {
            await Manifest({ root }).env.set("TELEGRAM_BOT_TOKEN", "new")

            // The whole file, unchanged but for the one value — not a
            // re-serialised bag of pairs with the comments dropped.
            expect(await read(root)).toBe([
                "# telegram",
                "TELEGRAM_BOT_TOKEN=new",
                "",
                "# other",
                "OTHER=untouched",
                "",
            ].join("\n"))
        }, seed)
    })

    test("appends without disturbing what is already there", async () => {
        await withRoot(async root => {
            await Manifest({ root }).env.set("SECOND", "2")

            expect(await read(root)).toBe("FIRST=1\nSECOND=2\n")
        }, "FIRST=1\n")
    })

    test("appends onto a file with no trailing newline", async () => {
        // Without the separator this lands as `FIRST=1SECOND=2`, silently
        // corrupting the key above it.
        await withRoot(async root => {
            await Manifest({ root }).env.set("SECOND", "2")

            expect(Manifest({ root }).env.parse(await read(root))).toEqual({ FIRST: "1", SECOND: "2" })
        }, "FIRST=1")
    })

    test("does not duplicate an export-prefixed key", async () => {
        await withRoot(async root => {
            const manifest = Manifest({ root })
            await manifest.env.set("TOKEN", "new")

            // The parser accepts `export TOKEN=...`, so a writer that missed
            // that form would append a second TOKEN below the first.
            expect(manifest.env.parse(await read(root))).toEqual({ TOKEN: "new" })
        }, "export TOKEN=old\n")
    })

    test("quotes a value that could not survive bare", async () => {
        await withRoot(async root => {
            const manifest = Manifest({ root })
            // Unquoted, `#` reads as a trailing comment and the spaces are
            // trimmed — the value would come back wrong.
            await manifest.env.set("MESSAGE", "hello # world")

            expect(manifest.env.parse(await read(root))).toEqual({ MESSAGE: "hello # world" })
        })
    })
})

describe("env.set: refusing at the keystroke, not at deploy", () => {
    test("rejects a malformed variable name", async () => {
        await withRoot(async root => {
            await expect(Manifest({ root }).env.set("not-a-name", "x"))
                .rejects.toMatchObject({ code: "AX-PROJECT-015" })
        })
    })

    test("rejects a framework-owned variable", async () => {
        // These are set by the runtime. Caught here rather than at deploy,
        // which is the worst moment to learn a key set days ago was never
        // going to work.
        await withRoot(async root => {
            await expect(Manifest({ root }).env.set("PORT", "9999"))
                .rejects.toMatchObject({ code: "AX-PROJECT-043" })
        })
    })

    test("a rejected write leaves the file untouched", async () => {
        await withRoot(async root => {
            await expect(Manifest({ root }).env.set("PORT", "9999")).rejects.toThrow()

            expect(await read(root)).toBe("FIRST=1\n")
        }, "FIRST=1\n")
    })
})
