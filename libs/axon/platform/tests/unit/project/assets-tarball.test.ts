import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Deep imports, matching how publish-verify.test.ts reaches its subject: these
// are build internals with no reason to widen `build/project`'s public index.
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
 * What actually ships — the two ARCHIVES, not the report.
 *
 * This file exists for two bugs, and both are worth stating because the tests
 * below are shaped by them.
 *
 * 1. A full unit suite for `Assets()` passed while publish shipped a tarball
 *    with NO assets: every test asserted on the returned report, which claimed
 *    four compressed images, and none opened an archive. A report is a claim
 *    about an artifact and cannot stand in for it.
 *
 * 2. Assets were then shipped INSIDE source.tar.gz, which put docs media on the
 *    install path. Measured on @axon/ember-theme: 60,272 of 60,844 bytes (99%)
 *    of the payload was screenshots for 5KB of code, downloaded by every
 *    `axon install` and read by nobody. The separation below is the fix, and
 *    `source.tar.gz has no assets/ member` is the assertion that protects it.
 */

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==",
    "base64",
)

/** A minimal publishable extension project. */
async function extensionProject(files: Record<string, Buffer | string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-tarball-"))
    const all: Record<string, Buffer | string> = {
        "package.json": JSON.stringify({ name: "@test/ext", version: "1.0.0" }),
        "extension.config.ts": "export default defineExtension({})\n",
        "main.ts": "// entry\n",
        ...files,
    }
    for (const [path, content] of Object.entries(all)) {
        const target = join(root, path)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, content)
    }
    return root
}

async function build(root: string) {
    const bundle = Bundle({ root, manifest: Manifest({ root }), modules: undefined as never, prepare: () => noPrepare })
    return bundle.build("extension")
}

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

/** One member's bytes, read without extracting to disk. */
async function member(tarball: string, path: string): Promise<Buffer> {
    const out = await Bun.$`tar -xzOf ${tarball} ${path}`.quiet()
    return Buffer.from(out.stdout)
}

describe("source.tar.gz carries code, never assets", () => {
    /**
     * The regression test for the install-cost bug. If an `assets/` member ever
     * reappears here, every consumer of this artifact is downloading docs media
     * again.
     */
    test("source.tar.gz has no assets/ member", async () => {
        const root = await extensionProject({
            "assets/shot.png": PNG,
            "assets/clip.mp4": Buffer.alloc(256, 7),
        })

        const artifact = await build(root)
        const inSource = await members(artifact.tarball)

        expect(inSource.some(name => name.startsWith("assets/"))).toBe(false)
        expect(inSource).toContain("main.ts")
        expect(inSource).toContain("package.json")
    })

    test("source.tar.gz stays small when the project has heavy assets", async () => {
        const withAssets = await extensionProject({ "assets/big.mp4": Buffer.alloc(2 * 1024 * 1024, 9) })
        const without = await extensionProject({})

        const [a, b] = [await build(withAssets), await build(without)]
        const sizeOf = async (path: string) => (await Bun.file(path).stat()).size

        // A 2MB asset must not move the install payload at all. Compared rather
        // than bounded by a constant so this keeps meaning as the fixture grows.
        const delta = Math.abs(await sizeOf(a.tarball) - await sizeOf(b.tarball))
        expect(delta).toBeLessThan(1024)
    })
})

describe("assets.tar.gz is its own artifact", () => {
    test("it exists, beside the source tarball, when the project has assets", async () => {
        const root = await extensionProject({ "assets/shot.png": PNG })

        const artifact = await build(root)

        expect(artifact.assetsTarball).toBe(join(artifact.dir, "assets.tar.gz"))
        expect(await Bun.file(artifact.assetsTarball!).exists()).toBe(true)
    })

    test("it is absent when the project has none — not an empty archive", async () => {
        const root = await extensionProject({})

        const artifact = await build(root)

        expect(artifact.assetsTarball).toBeNull()
        expect(artifact.assets).toEqual([])
    })

    test("members are assets/<path> with no npm package/ prefix", async () => {
        const root = await extensionProject({
            "assets/a.png": PNG,
            "assets/nested/b.png": PNG,
        })

        const artifact = await build(root)
        const listing = await Bun.$`tar -tzf ${artifact.assetsTarball!}`.quiet()
        const names = listing.stdout.toString().split("\n").filter(name => name && !name.endsWith("/"))

        expect(names.sort()).toEqual(["assets/a.png", "assets/nested/b.png"])
        expect(names.some(name => name.startsWith("package/"))).toBe(false)
    })

    test("every asset the report claims is actually a member of the archive", async () => {
        const root = await extensionProject({
            "assets/a.png": PNG,
            "assets/nested/b.png": PNG,
            "assets/clip.mp4": Buffer.alloc(256, 3),
        })

        const artifact = await build(root)
        const listing = await Bun.$`tar -tzf ${artifact.assetsTarball!}`.quiet()
        const names = listing.stdout.toString().split("\n").filter(Boolean)

        expect(artifact.assets.length).toBe(3)
        for (const asset of artifact.assets) {
            expect(names).toContain(asset.path)
        }
    })

    test("the archive carries the COMPRESSED bytes, not the originals", async () => {
        const root = await extensionProject({ "assets/shot.png": PNG })

        const artifact = await build(root)
        const shipped = await member(artifact.assetsTarball!, "assets/shot.png")
        const report = artifact.assets[0]!

        expect(shipped.byteLength).toBe(report.final)
        if (report.compressed) expect(shipped.byteLength).toBeLessThan(report.original)
    })

    test("a removed asset does not survive from a previous build", async () => {
        const root = await extensionProject({ "assets/a.png": PNG, "assets/b.png": PNG })
        await build(root)

        // Author deletes one and republishes. The previous archive is still in
        // the bundle directory, so it must be cleared rather than re-sent.
        await Bun.$`rm ${join(root, "assets/b.png")}`.quiet()
        const artifact = await build(root)
        const listing = await Bun.$`tar -tzf ${artifact.assetsTarball!}`.quiet()

        expect(listing.stdout.toString()).toContain("assets/a.png")
        expect(listing.stdout.toString()).not.toContain("assets/b.png")
    })

    /**
     * EVERY publishable kind carries assets, not just the source-bundled ones.
     *
     * The three bundlers (agent, module, source) each assemble their own tarball,
     * and assets were wired into `source` alone. So an agent with a demo mp4 in
     * `assets/` published with no assets at all — the CLI said nothing, the
     * tarball was valid, and the registry page rendered an empty video player.
     * The author's only signal was a broken page.
     *
     * Asserted per BUNDLER rather than per kind, because the bundler is where the
     * omission lives: `KINDS` maps seven kinds onto three of them, so covering
     * the three covers all seven.
     */
    test("a module carries assets — the module bundler, not just source", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-mod-"))
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "@test/mod", version: "1.0.0" }))
        await writeFile(join(root, "module.config.ts"), "export default defineModule({})\n")
        await mkdir(join(root, "assets"), { recursive: true })
        await writeFile(join(root, "assets/shot.png"), PNG)

        const bundle = Bundle({ root, manifest: Manifest({ root }), modules: undefined as never, prepare: () => noPrepare })
        const artifact = await bundle.build("module")

        expect(artifact.assetsTarball).not.toBeNull()
        expect(artifact.assets.map(a => a.path)).toEqual(["assets/shot.png"])
        // And still not in the install payload.
        expect((await members(artifact.tarball)).some(n => n.startsWith("assets/"))).toBe(false)
    })

    test("deleting every asset leaves no stale archive to upload", async () => {
        const root = await extensionProject({ "assets/a.png": PNG })
        await build(root)

        await Bun.$`rm -rf ${join(root, "assets")}`.quiet()
        const artifact = await build(root)

        // Must be null, not a leftover file from the previous build — publish
        // sends the part whenever the file exists.
        expect(artifact.assetsTarball).toBeNull()
        expect(await Bun.file(join(artifact.dir, "assets.tar.gz")).exists()).toBe(false)
    })
})
