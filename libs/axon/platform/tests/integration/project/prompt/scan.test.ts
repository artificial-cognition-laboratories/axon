import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanPromptPackage } from "../../../../src/build/blueprint/scan/promptPackages"
import { describe, it, expect } from "bun:test"

/**
 * How a published prompt package becomes invokable prompts.
 *
 * These properties are about NAMING and MEMBERSHIP — which files in a package
 * are prompts, and what each one is called. They used to be asserted through a
 * blueprint load, back when an agent declared `prompts: [...]` and the scan ran
 * over its node_modules. Prompts are no longer installed into an agent: they
 * resolve into a global cache and render on demand, so the same scan now runs
 * over a cache directory and no agent is involved at all.
 *
 * The rules did not change with the location, which is the point of testing
 * the scanner directly rather than through whatever happens to call it.
 */
async function scanPackage(
    name: string,
    files: Record<string, string>,
): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-prompt-cache-"))
    try {
        for (const [relative, contents] of Object.entries(files)) {
            const target = join(root, relative)
            await mkdir(join(target, ".."), { recursive: true })
            await writeFile(target, contents)
        }
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ name, version: "0.1.0", type: "module" }, null, 2),
        )

        const scanned = await scanPromptPackage(root, name)
        return scanned.entries.map(prompt => prompt.name).sort()
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const TEMPLATE = "<template><p>x</p></template>\n"

describe("prompt package: scan", () => {
    it("makes every top-level .vue and .md invokable, namespaced by package", async () => {
        const names = await scanPackage("@scope/pack", {
            "one.vue": TEMPLATE,
            "two.md": "two\n",
        })

        expect(names).toContain("@scope/pack:one")
        expect(names).toContain("@scope/pack:two")
    })

    it("does not make README.md invokable — it is documentation", async () => {
        const names = await scanPackage("@scope/pack", {
            "one.vue": TEMPLATE,
            "README.md": "# docs\n",
        })

        expect(names).toContain("@scope/pack:one")
        expect(names).not.toContain("@scope/pack:README")
    })

    it("does not make components/ invokable — they are fragments", async () => {
        const names = await scanPackage("@scope/pack", {
            "one.vue": TEMPLATE,
            "components/shared.vue": TEMPLATE,
        })

        expect(names).toContain("@scope/pack:one")
        expect(names.some(name => name.includes("shared"))).toBe(false)
    })

    it("answers to the bare package name when it ships a single self-titled prompt", async () => {
        const names = await scanPackage("@scope/solo", {
            "solo.vue": TEMPLATE,
        })

        // The common case reads as one thing, not a package with one member.
        expect(names).toContain("@scope/solo")
        expect(names).toContain("@scope/solo:solo")
    })

    it("keeps the namespace when a package ships more than one prompt", async () => {
        const names = await scanPackage("@scope/pack", {
            "pack.vue": TEMPLATE,
            "other.vue": TEMPLATE,
        })

        // The shorthand is for the single-prompt case only — with siblings,
        // a bare name would be ambiguous.
        expect(names).not.toContain("@scope/pack")
        expect(names).toContain("@scope/pack:pack")
        expect(names).toContain("@scope/pack:other")
    })

    it("scans an agent-shaped package from its src/prompts/", async () => {
        // A package authored like an agent keeps its prompts nested; a flat
        // one puts them at the root. Both are legitimate layouts and produce
        // the same names.
        const names = await scanPackage("@scope/nested", {
            "src/prompts/deep.vue": TEMPLATE,
        })

        expect(names).toContain("@scope/nested:deep")
    })
})
