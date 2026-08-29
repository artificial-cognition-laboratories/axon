import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Deep imports, matching assets-tarball.test.ts: these are build internals
// with no reason to widen `build/project`'s public index.
import { Bundle } from "@arcforge/platform/build/project/bundle/bundle"
import { Manifest } from "@arcforge/platform/build/project/manifest/index"

/**
 * Bundle prepares the project before packaging it. These tests build from a
 * fixture directory that is already exactly what the assertion is about, so
 * there is nothing to bring up to date — a real no-op rather than a cast, so
 * the call still happens and a change to how Bundle invokes it still shows up
 * here.
 */
const noPrepare = async () => {}

/**
 * What actually ships when a project carries knowledge — the ARCHIVE, not a
 * report about it.
 *
 * This file exists for a real bug. @axon/docs published 194 markdown files as
 * a package containing none of them: the bundler's entry list named
 * module.config.ts, package.json, src/ and server/, and `data/knowledge/` was
 * simply absent. Everything downstream behaved correctly on an empty input —
 * the module installed, the scanner ran, the catalogue came back empty — so
 * the only visible symptom was knowledge that mysteriously did not exist.
 *
 * It is the same omission `server/` had before it, in the same list, and the
 * lesson from `assets-tarball.test.ts` applies exactly: a scanner test proves
 * the scanner reads a directory, never that publish put one in the tarball.
 * Assert on the artifact.
 */

/** Member names inside an archive, with npm's `package/` prefix stripped. */
async function members(tarball: string): Promise<string[]> {
    const listing = await Bun.$`tar -tzf ${tarball}`.quiet()
    return listing.stdout
        .toString()
        .split("\n")
        .filter(Boolean)
        .map(name => name.replace(/^package\//, ""))
        .filter(name => name && !name.endsWith("/"))
        .sort()
}

/** A minimal publishable module project. */
async function moduleProject(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-knowledge-tar-"))
    const all: Record<string, string> = {
        "package.json": JSON.stringify({ name: "@test/docs", version: "1.0.0" }),
        "module.config.ts": "export default defineModule({})\n",
        ...files,
    }
    for (const [path, content] of Object.entries(all)) {
        const target = join(root, path)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, content)
    }
    return root
}

async function build(root: string, kind: "module") {
    const bundle = Bundle({ root, manifest: Manifest({ root }), modules: undefined as never, prepare: () => noPrepare })
    return bundle.build(kind)
}

describe("a module's knowledge ships with it", () => {
    test("data/knowledge/ files are members of the tarball", async () => {
        // The regression. Without this the package installs clean and knows
        // nothing.
        const root = await moduleProject({
            "data/knowledge/agent.md": "---\ntitle: Agents\n---\n",
            "data/knowledge/tui/theme.md": "---\ntitle: Theme\n---\n",
        })

        const shipped = await members((await build(root, "module")).tarball)

        expect(shipped).toContain("data/knowledge/agent.md")
        expect(shipped).toContain("data/knowledge/tui/theme.md")
    })

    test("nested material keeps its path, since the path IS the entry name", async () => {
        // The scanner derives an entry's name from its store-relative path, so
        // a tarball that flattened the tree would rename every entry the model
        // was told it could read.
        const root = await moduleProject({ "data/knowledge/a/b/c/deep.md": "deep" })

        expect(await members((await build(root, "module")).tarball)).toContain("data/knowledge/a/b/c/deep.md")
    })

    test("a module with no knowledge still publishes", async () => {
        // Most modules have none — an absent directory is an empty surface,
        // never a build failure.
        const root = await moduleProject({})

        const shipped = await members((await build(root, "module")).tarball)

        expect(shipped).toContain("module.config.ts")
        expect(shipped.some(name => name.startsWith("data/"))).toBe(false)
    })

    test("only knowledge ships from data/, never workspace or module state", async () => {
        // The other rooms under data/ are an AGENT's runtime scratch — cloned
        // repos, caches, sync cursors. A module shipping either would be
        // publishing one installation's private state to everyone.
        const root = await moduleProject({
            "data/knowledge/real.md": "real",
            "data/workspace/scratch.txt": "scratch",
            "data/modules/@other/cursor.json": "{}",
        })

        const shipped = await members((await build(root, "module")).tarball)

        expect(shipped).toContain("data/knowledge/real.md")
        expect(shipped.some(name => name.startsWith("data/workspace/"))).toBe(false)
        expect(shipped.some(name => name.startsWith("data/modules/"))).toBe(false)
    })
})
