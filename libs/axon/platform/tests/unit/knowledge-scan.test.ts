import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Knowledge } from "../../src/build/blueprint/scan/knowledge"
import { describe, it, expect } from "bun:test"

/**
 * The knowledge scanner — build-time discovery of data/knowledge/.
 *
 * This is where WALKING lives: the kernel is handed entries and never touches
 * a directory, so everything about finding files, reading frontmatter and
 * namespacing a module's material is asserted here rather than through the
 * runtime.
 */

/** A project root with data/knowledge/ seeded from a name → content map. */
async function project(entries: Record<string, string> = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-kscan-"))
    for (const [name, content] of Object.entries(entries)) {
        const file = join(root, "data", "knowledge", name)
        await mkdir(dirOf(file), { recursive: true })
        await writeFile(file, content)
    }
    return root
}

function dirOf(file: string): string {
    return file.slice(0, file.lastIndexOf("/"))
}

describe("knowledge scan: discovery", () => {
    it("returns nothing when the project has no knowledge directory", async () => {
        // Most projects never author one — an empty surface, not an error.
        const { entries, warnings } = await Knowledge(await project())
        expect(entries).toEqual([])
        expect(warnings).toEqual([])
    })

    it("catalogues files by their store-relative name", async () => {
        const { entries } = await Knowledge(await project({
            "axon/terminal.md": "terminal",
            "root.md": "root",
        }))
        expect(entries.map(e => e.name).sort()).toEqual(["axon/terminal.md", "root.md"])
    })

    it("records the absolute path so the runtime never re-derives it", async () => {
        const root = await project({ "notes.md": "body" })
        const { entries } = await Knowledge(root)
        expect(entries[0]?.path).toBe(join(root, "data", "knowledge", "notes.md"))
    })

    it("skips dotfiles at every depth", async () => {
        // Editor swap files, .DS_Store, .gitkeep — noise a model must never
        // spend context reading past.
        const { entries } = await Knowledge(await project({
            ".gitkeep": "",
            "axon/.hidden.md": "hidden",
            "real.md": "real",
        }))
        expect(entries.map(e => e.name)).toEqual(["real.md"])
    })

    it("follows a symlinked directory, so an existing corpus can be mounted", async () => {
        // readdir reports a symlink as a symlink rather than as what it points
        // at; a walk that trusted the dirent treated a linked corpus as a file.
        const source = await mkdtemp(join(tmpdir(), "axon-corpus-"))
        await writeFile(join(source, "guide.md"), "---\ntitle: Guide\n---\n")

        const root = await project({ "local.md": "local" })
        await symlink(source, join(root, "data", "knowledge", "docs"))

        const { entries } = await Knowledge(root)
        expect(entries.map(e => e.name).sort()).toEqual(["docs/guide.md", "local.md"])
    })
})

describe("knowledge scan: descriptions", () => {
    it("reads a declared description", async () => {
        const { entries } = await Knowledge(await project({
            "a.md": "---\ndescription: loop, tick, phase and the world clock.\n---\n",
        }))
        expect(entries[0]?.description).toBe("loop, tick, phase and the world clock.")
    })

    it("prefers description over title when both are present", async () => {
        const { entries } = await Knowledge(await project({
            "a.md": "---\ntitle: The Loop\ndescription: The real summary.\n---\n",
        }))
        expect(entries[0]?.description).toBe("The real summary.")
    })

    it("falls back to title, so an uneven corpus still catalogues usefully", async () => {
        // The Axon docs carry a title on 193 of 194 files and a description on
        // 32. Reading only the richer field leaves most entries bare.
        const { entries } = await Knowledge(await project({ "a.md": "---\ntitle: Agent\n---\n" }))
        expect(entries[0]?.description).toBe("Agent")
    })

    it("reports an empty description for material with no frontmatter", async () => {
        // A .json corpus is legitimate knowledge. Empty string, never
        // undefined — a renderer must not have to branch.
        const { entries } = await Knowledge(await project({ "weather.json": '{"city":"chicago"}' }))
        expect(entries[0]?.description).toBe("")
    })

    it("strips surrounding quotes", async () => {
        const { entries } = await Knowledge(await project({ "a.md": `---\ntitle: "Quoted"\n---\n` }))
        expect(entries[0]?.description).toBe("Quoted")
    })
})

describe("knowledge scan: module material", () => {
    it("namespaces a module's entries and marks them read-only in origin", async () => {
        // Two corpora on one subject is normal; the namespace is what stops
        // one silently shadowing the other in a flat catalogue.
        const { entries } = await Knowledge(await project({ "agent.md": "module copy" }), { prefix: "@axon/docs" })

        expect(entries[0]?.name).toBe("@axon/docs/agent.md")
        expect(entries[0]?.origin).toBe("module")
        expect(entries[0]?.module).toBe("@axon/docs")
    })

    it("marks an agent's own material as writable", async () => {
        const { entries } = await Knowledge(await project({ "agent.md": "agent copy" }))
        expect(entries[0]?.origin).toBe("agent")
        expect(entries[0]?.module).toBeUndefined()
    })
})
