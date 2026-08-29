import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Extensions } from "@arcforge/platform/build/extensions"

/**
 * "Is a newer version available?" is a COMPARISON, not an inequality.
 *
 * `outdated` was `latest !== version`, so a registry serving an OLDER version
 * than the user has — a yank, a rollback, a staging endpoint — reported them
 * as out of date and offered an "update" that was a downgrade. The user's only
 * signal would have been the version number going backwards after accepting.
 *
 * Unit-level with an injected `latest`, deliberately: the rule under test is
 * arithmetic on two version strings, and the integration fixture publishes to
 * the real registry, where producing "the registry went backwards" is not
 * something a test can arrange.
 */

async function withConfig(
    entries: string[],
    latest: (name: string) => Promise<string>,
    fn: (extensions: ReturnType<typeof Extensions>) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-outdated-"))
    try {
        await writeFile(
            join(root, "profile.config.ts"),
            `export default defineProfile({ extensions: [${entries.map(e => `"${e}"`).join(", ")}] })\n`,
        )
        await fn(Extensions({ root: () => root, latest }))
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("extension updates", () => {
    test("a newer version is an update", async () => {
        await withConfig(["@cody/theme@1.0.0"], async () => "1.1.0", async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.outdated).toBe(true)
            expect(entry?.latest).toBe("1.1.0")
        })
    })

    test("the same version is not an update", async () => {
        await withConfig(["@cody/theme@1.0.0"], async () => "1.0.0", async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.outdated).toBe(false)
        })
    })

    test("an OLDER version on the registry is not an update", async () => {
        // The downgrade case. A string inequality reports this as outdated.
        await withConfig(["@cody/theme@2.0.0"], async () => "1.0.0", async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.current).toBe("2.0.0")
            expect(entry?.latest).toBe("1.0.0")
            expect(entry?.outdated).toBe(false)
        })
    })

    test("0.9.0 → 0.10.0 is an update, where string order says otherwise", async () => {
        // The digit boundary. "0.10.0" < "0.9.0" as strings.
        await withConfig(["@cody/theme@0.9.0"], async () => "0.10.0", async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.outdated).toBe(true)
        })
    })

    test("an unparseable version is never reported as outdated", async () => {
        // Unknown is not out of date. Offering an "update" from a version
        // nothing can compare is a guess presented as a fact.
        await withConfig(["@cody/theme@nightly"], async () => "1.0.0", async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.outdated).toBe(false)
        })
    })

    test("an unreachable registry reports unknown, not up to date", async () => {
        await withConfig(["@cody/theme@1.0.0"], async () => { throw new Error("offline") }, async extensions => {
            const [entry] = await extensions.updates()
            expect(entry?.latest).toBeNull()
            expect(entry?.outdated).toBe(false)
        })
    })
})
