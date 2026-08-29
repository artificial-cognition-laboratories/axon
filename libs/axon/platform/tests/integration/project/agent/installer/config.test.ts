import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"

/**
 * axon.config.ts is a file the author owns and reads. These cover the
 * property that matters: an install edits ONLY the modules array, leaving
 * imports, source-module entries, formatting, and every other key intact.
 */

async function withConfig(source: string, run: (root: string) => Promise<void>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-config-"))
    try {
        await writeFile(join(root, "axon.config.ts"), source)
        await run(root)
        return await readFile(join(root, "axon.config.ts"), "utf-8")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const WITH_SOURCE_MODULES = `import FsModule from "../mods/fs/module.config"

export default defineAgent({
    description: "test",
    modules: [FsModule],

    engine: Codex({ model: "gpt-5.6-terra" }),
})
`

describe("axon.config.ts module entries", () => {
    it("adds a registry module alongside existing source modules", async () => {
        const result = await withConfig(WITH_SOURCE_MODULES, root => Manifest({ root }).config.add("@axon/obsidian").then(() => {}))

        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain("FsModule")
        expect(result).toContain(`import FsModule from "../mods/fs/module.config"`)
        expect(result).toContain(`engine: Codex({ model: "gpt-5.6-terra" })`)
    })

    it("is idempotent — adding an already-declared module changes nothing", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-config-"))
        try {
            await writeFile(join(root, "axon.config.ts"), WITH_SOURCE_MODULES)

            expect(await Manifest({ root }).config.add("@axon/obsidian")).toBe(true)
            const afterFirst = await readFile(join(root, "axon.config.ts"), "utf-8")

            expect(await Manifest({ root }).config.add("@axon/obsidian")).toBe(false)
            expect(await readFile(join(root, "axon.config.ts"), "utf-8")).toBe(afterFirst)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("populates an empty modules array", async () => {
        const result = await withConfig(
            `export default defineAgent({\n    modules: [],\n})\n`,
            root => Manifest({ root }).config.add("@axon/first").then(() => {}),
        )

        expect(result).toContain(`"@axon/first"`)
        expect(result).toMatch(/modules: \[\s*\n/)
    })

    it("removes a module without disturbing the others", async () => {
        const result = await withConfig(WITH_SOURCE_MODULES, async root => {
            await Manifest({ root }).config.add("@axon/obsidian")
            await Manifest({ root }).config.add("@axon/tavily")
            await Manifest({ root }).config.remove("@axon/obsidian")
        })

        expect(result).not.toContain("@axon/obsidian")
        expect(result).toContain(`"@axon/tavily"`)
        expect(result).toContain("FsModule")
    })

    it("reports a module that was never declared as not removed", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-config-"))
        try {
            await writeFile(join(root, "axon.config.ts"), WITH_SOURCE_MODULES)
            expect(await Manifest({ root }).config.remove("@axon/never-added")).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    // A freshly scaffolded agent has no modules key at all — creating it is
    // part of installing, not a thing to make the user do by hand.
    it("creates the modules key when the config has none", async () => {
        const result = await withConfig(
            `export default defineAgent({\n    description: "fresh",\n\n    engine: Axon({ model: "auto" }),\n})\n`,
            root => Manifest({ root }).config.add("@axon/obsidian").then(() => {}),
        )

        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain(`description: "fresh"`)
        expect(result).toContain(`engine: Axon({ model: "auto" })`)
    })

    it("appends to a modules key it created earlier", async () => {
        const result = await withConfig(
            `export default defineAgent({\n    description: "fresh",\n})\n`,
            async root => {
                await Manifest({ root }).config.add("@axon/obsidian")
                await Manifest({ root }).config.add("@axon/tavily")
            },
        )

        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain(`"@axon/tavily"`)
    })

    /**
     * The scaffolded shape, and the one that was broken.
     *
     * `create/templates.ts` writes `defineAgent({})` on ONE line, and every
     * fixture above spans lines — so the first install into every fresh agent
     * installed the package, failed to record it, and left an agent that did
     * not load the module it had just been given. A test per shape, because
     * the shape is the input that matters here.
     */
    it("creates the modules key in an empty single-line config", async () => {
        const result = await withConfig(
            `// https://axon.arclabs.it/docs/v2/agent/config\nexport default defineAgent({})\n`,
            root => Manifest({ root }).config.add("@axon/obsidian").then(() => {}),
        )

        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain("modules: [")
        // The comment above the call is the author's; rewriting the object
        // must not disturb anything around it.
        expect(result).toContain("// https://axon.arclabs.it/docs/v2/agent/config")
    })

    it("appends to a modules key created from an empty single-line config", async () => {
        const result = await withConfig(
            `export default defineAgent({})\n`,
            async root => {
                await Manifest({ root }).config.add("@axon/obsidian")
                await Manifest({ root }).config.add("@axon/tavily")
            },
        )

        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain(`"@axon/tavily"`)
    })

    it("throws rather than guessing when the config has no defineAgent call", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-config-"))
        try {
            await writeFile(join(root, "axon.config.ts"), `export default someOtherThing({})\n`)
            await expect(Manifest({ root }).config.add("@axon/obsidian")).rejects.toThrow()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    // Options tuples contain a nested array; the scan must not mistake its
    // closing bracket for the end of the modules array.
    it("handles entries carrying options tuples", async () => {
        const result = await withConfig(
            `export default defineAgent({\n    modules: [\n        ["@axon/kanban", { board: "main" }],\n    ],\n})\n`,
            root => Manifest({ root }).config.add("@axon/obsidian").then(() => {}),
        )

        expect(result).toContain(`["@axon/kanban", { board: "main" }]`)
        expect(result).toContain(`"@axon/obsidian"`)
        expect(result).toContain("})")
    })
})
