import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtensionStore, formatRef, parseRef } from "@arcforge/platform/build/extensions"

/**
 * The machine-wide extension store — one fetched copy, many profiles.
 *
 * The property that makes sharing safe: a profile REFERENCES a version rather
 * than owning a directory. So the store has to be able to hold two versions of
 * the same extension at once, and a pinned ref must resolve to exactly the
 * version it names — never to a neighbour, because a pin that silently drifts
 * is not a pin.
 */

async function withStore(fn: (store: ReturnType<typeof ExtensionStore>) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-extstore-"))
    try {
        await fn(ExtensionStore({ root }))
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

/** Materialize a usable extension at name@version. */
async function store(s: ReturnType<typeof ExtensionStore>, name: string, version: string): Promise<string> {
    const dir = s.pathFor(name, version)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "extension.config.ts"), "export default defineExtension({})\n")
    return dir
}

describe("parseRef", () => {
    test("splits on the LAST @, so a scope is not mistaken for a version", () => {
        // The leading @ of a scope is not a delimiter. Splitting on the first
        // one would read "@cody/theme" as version "cody/theme".
        expect(parseRef("@cody/ember-theme@0.1.0")).toEqual({ name: "@cody/ember-theme", version: "0.1.0" })
        expect(parseRef("@cody/ember-theme")).toEqual({ name: "@cody/ember-theme", version: null })
        expect(parseRef("vim@2.0.0")).toEqual({ name: "vim", version: "2.0.0" })
        expect(parseRef("vim")).toEqual({ name: "vim", version: null })
    })

    test("keeps a prerelease version intact", () => {
        expect(parseRef("@scope/a@1.2.3-beta.1")).toEqual({ name: "@scope/a", version: "1.2.3-beta.1" })
    })

    test("round-trips through formatRef", () => {
        const ref = formatRef("@cody/ember-theme", "0.1.0")
        expect(ref).toBe("@cody/ember-theme@0.1.0")
        expect(parseRef(ref)).toEqual({ name: "@cody/ember-theme", version: "0.1.0" })
    })
})

describe("ExtensionStore", () => {
    test("holds two versions of one extension at once", async () => {
        await withStore(async s => {
            await store(s, "@cody/theme", "0.1.0")
            await store(s, "@cody/theme", "0.2.0")

            // This is what lets two profiles pin different versions without
            // either changing under the other — the reason a shared store is
            // safe rather than a shared mutable directory.
            // Newest first — the order every caller reads position 0 of.
            expect(s.versions("@cody/theme")).toEqual(["0.2.0", "0.1.0"])
            expect(s.resolve("@cody/theme@0.1.0")?.root).toBe(s.pathFor("@cody/theme", "0.1.0"))
            expect(s.resolve("@cody/theme@0.2.0")?.root).toBe(s.pathFor("@cody/theme", "0.2.0"))
        })
    })

    test("a pinned ref resolves to that version or to nothing", async () => {
        await withStore(async s => {
            await store(s, "@cody/theme", "0.1.0")

            // Never a neighbour. Loading 0.1.0 when the config says 0.3.0
            // would make a pinned config stop meaning anything.
            expect(s.resolve("@cody/theme@0.3.0")).toBeNull()
        })
    })

    test("an unpinned ref takes the newest present", async () => {
        await withStore(async s => {
            await store(s, "@cody/theme", "0.1.0")
            await store(s, "@cody/theme", "0.2.0")

            // The legacy shape — a config written before pinning existed still
            // loads rather than reporting the extension as missing.
            expect(s.resolve("@cody/theme")?.version).toBe("0.2.0")
        })
    })

    test("newest is decided by SEMVER, not by string order", async () => {
        await withStore(async s => {
            // 0.10.0 sorts BEFORE 0.9.0 as a string, so a lexical order
            // resolved an unpinned entry to the older copy and left it there.
            // Every fixture in this file used single-digit versions, where the
            // two orders agree — so the suite pinned the example and the rule
            // went unguarded until a user updated twice.
            await store(s, "@cody/theme", "0.9.0")
            await store(s, "@cody/theme", "0.10.0")
            await store(s, "@cody/theme", "0.2.0")

            expect(s.versions("@cody/theme")).toEqual(["0.10.0", "0.9.0", "0.2.0"])
            expect(s.resolve("@cody/theme")?.version).toBe("0.10.0")
        })
    })

    test("a directory that is not a version is not offered as one", async () => {
        await withStore(async s => {
            // Only an install writes here, and it writes what the registry
            // resolved — so a non-semver directory is something else that got
            // in. Guessing where it belongs in a version order is how a stray
            // folder becomes "the newest version".
            await store(s, "@cody/theme", "1.0.0")
            await store(s, "@cody/theme", "backup")

            expect(s.versions("@cody/theme")).toEqual(["1.0.0"])
            expect(s.resolve("@cody/theme")?.version).toBe("1.0.0")
        })
    })

    test("a directory without the marker config is not a version", async () => {
        await withStore(async s => {
            // An interrupted fetch leaves a directory behind. Counting it as a
            // version would make an unpinned ref resolve to a broken copy.
            await mkdir(s.pathFor("@cody/theme", "0.1.0"), { recursive: true })
            expect(s.versions("@cody/theme")).toEqual([])
            expect(s.resolve("@cody/theme")).toBeNull()
        })
    })

    test("lists scoped and bare names alike", async () => {
        await withStore(async s => {
            await store(s, "@cody/theme", "0.1.0")
            await store(s, "@axon/vim", "1.0.0")
            await store(s, "solo", "0.0.1")

            const listed = s.list().map(e => formatRef(e.name, e.version)).sort()
            expect(listed).toEqual(["@axon/vim@1.0.0", "@cody/theme@0.1.0", "solo@0.0.1"])
        })
    })

    test("remove deletes one version and leaves its siblings", async () => {
        await withStore(async s => {
            await store(s, "@cody/theme", "0.1.0")
            await store(s, "@cody/theme", "0.2.0")

            await s.remove("@cody/theme", "0.1.0")

            expect(existsSync(s.pathFor("@cody/theme", "0.1.0"))).toBe(false)
            // The version another profile may still be pinned to survives.
            expect(existsSync(s.pathFor("@cody/theme", "0.2.0"))).toBe(true)
        })
    })

    test("an empty store lists nothing rather than throwing", async () => {
        await withStore(async s => {
            expect(s.list()).toEqual([])
            expect(s.versions("@cody/theme")).toEqual([])
            expect(s.resolve("@cody/theme")).toBeNull()
        })
    })
})
