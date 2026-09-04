import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"
import { describe, it, expect } from "bun:test"

/**
 * bunfig.toml — the agent's scope → registry map.
 *
 * Bun resolves a package by looking up its SCOPE, so every namespace an agent
 * installs from must appear here or Bun asks npmjs.com and 404s. `@axon` is
 * scaffolded in, but modules are published under user and org namespaces too
 * and those cannot be known ahead of time — installing from a scope for the
 * first time registers it.
 *
 * This is what makes `bun add` resolve an Axon package at all. It had no
 * coverage.
 */

const REGISTRY = "http://localhost:3099/api/registry/npm/-"

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-bunfig-"))
    try {
        await run(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("manifest.bunfig", () => {
    it("creates the file and the [install.scopes] table on first registration", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            expect(existsSync(bunfig.path)).toBe(false)

            expect(await bunfig.ensure("axon", REGISTRY)).toBe(true)

            const content = await readFile(bunfig.path, "utf-8")
            expect(content).toContain("[install.scopes]")
            expect(content).toContain(`axon = { url = "${REGISTRY}" }`)
        })
    })

    it("is idempotent — re-registering a mapped scope changes nothing", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            await bunfig.ensure("axon", REGISTRY)
            const first = await readFile(bunfig.path, "utf-8")

            expect(await bunfig.ensure("axon", REGISTRY)).toBe(false)
            expect(await readFile(bunfig.path, "utf-8")).toBe(first)
        })
    })

    it("adds a second scope without disturbing the first", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            await bunfig.ensure("axon", REGISTRY)
            await bunfig.ensure("cody", REGISTRY)

            const content = await readFile(bunfig.path, "utf-8")
            expect(content).toContain(`axon = { url = "${REGISTRY}" }`)
            expect(content).toContain(`cody = { url = "${REGISTRY}" }`)
            expect(content.match(/\[install\.scopes\]/g)).toHaveLength(1)
        })
    })

    it("inserts directly under the header so an entry cannot land in a later table", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            await writeFile(bunfig.path, "[install.scopes]\n\n[install]\nregistry = \"https://registry.npmjs.org\"\n")

            await bunfig.ensure("cody", REGISTRY)

            const lines = (await readFile(bunfig.path, "utf-8")).split("\n")
            const header = lines.indexOf("[install.scopes]")
            // Immediately after the header, and therefore before any later table.
            expect(lines[header + 1]).toBe(`cody = { url = "${REGISTRY}" }`)
            expect(lines.indexOf("[install]")).toBeGreaterThan(header + 1)
        })
    })

    it("preserves an existing file's other content when appending a table", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            await writeFile(bunfig.path, "[test]\nroot = \"./tests\"\n")

            await bunfig.ensure("axon", REGISTRY)

            const content = await readFile(bunfig.path, "utf-8")
            expect(content).toContain("[test]")
            expect(content).toContain("root = \"./tests\"")
            expect(content).toContain("[install.scopes]")
        })
    })

    it("maps every scope a batch of package names implies, and only scopes", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig

            const changed = await bunfig.ensureAll(
                ["@axon/obsidian", "@cody/scout", "@axon/telegram", "unscoped-package"],
                REGISTRY,
            )

            expect(changed).toBe(true)
            const content = await readFile(bunfig.path, "utf-8")
            expect(content).toContain("axon = {")
            expect(content).toContain("cody = {")
            // An unscoped name has no scope to map — Bun resolves it from npm.
            expect(content).not.toContain("unscoped-package")
        })
    })

    it("reports no change when every scope in the batch is already mapped", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig
            await bunfig.ensureAll(["@axon/obsidian"], REGISTRY)

            expect(await bunfig.ensureAll(["@axon/telegram"], REGISTRY)).toBe(false)
        })
    })

    it("derives a scope from a package name, or null when there is none", async () => {
        await withRoot(async root => {
            const bunfig = Manifest({ root }).bunfig

            expect(bunfig.scopeOf("@axon/obsidian")).toBe("axon")
            expect(bunfig.scopeOf("@cody/scout")).toBe("cody")
            expect(bunfig.scopeOf("lodash")).toBeNull()
        })
    })
})
