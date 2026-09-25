import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ProfileConfigFile } from "@arcforge/platform/build/extensions/config"

/**
 * `profile.config.ts` is USER INPUT that this system executes.
 *
 * It is arbitrary TypeScript, hand-edited, and increasingly written by agents
 * — so every shape a person can produce by accident has to arrive as a named
 * error rather than a crash, a silent empty list, or nonsense.
 *
 * The suite tested wrong VALUES thoroughly and wrong SHAPES almost not at all,
 * which is how `extensions: "@cody/theme"` came to be walked character by
 * character. These cover the type axis.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function config(body: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-hostile-"))
    roots.push(root)
    await writeFile(join(root, "profile.config.ts"), body)
    return root
}

describe("a malformed profile.config.ts", () => {
    test("an empty file is reported, not treated as an empty config", async () => {
        // A truncated write and a deliberately empty config are different
        // states; only one of them is the user's intent.
        const result = await ProfileConfigFile(await config(``))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a file that is not TypeScript is reported", async () => {
        const result = await ProfileConfigFile(await config(`{{{ not typescript`))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a file that throws while evaluating is reported", async () => {
        const result = await ProfileConfigFile(await config(`throw new Error("hostile")\n`))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a numeric entry is refused rather than resolved", async () => {
        const result = await ProfileConfigFile(await config(
            `export default defineProfile({ extensions: [42] })`,
        ))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a null entry is refused", async () => {
        const result = await ProfileConfigFile(await config(
            `export default defineProfile({ extensions: [null] })`,
        ))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("an entry object with no source is refused", async () => {
        const result = await ProfileConfigFile(await config(
            `export default defineProfile({ extensions: [{ enabled: true }] })`,
        ))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("an empty source string is refused", async () => {
        // Resolves to the profile root itself if allowed through — an entry
        // that names nothing must not name everything.
        const result = await ProfileConfigFile(await config(
            `export default defineProfile({ extensions: [""] })`,
        ))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a config that never calls defineProfile is reported", async () => {
        const result = await ProfileConfigFile(await config(`export default {}\n`))

        expect(result.entries).toEqual([])
        expect(result.error).not.toBeNull()
    })

    test("a valid config still reads cleanly", async () => {
        // The control. Every refusal above must be about the input, not about
        // this path having become unusable.
        const result = await ProfileConfigFile(await config(
            `export default defineProfile({ extensions: ["@cody/theme@1.0.0"] })`,
        ))

        expect(result.error).toBeNull()
        expect(result.entries).toHaveLength(1)
        expect(result.entries[0]!.source).toBe("@cody/theme@1.0.0")
    })
})
