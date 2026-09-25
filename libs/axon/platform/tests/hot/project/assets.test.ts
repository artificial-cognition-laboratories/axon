import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Assets } from "@arcforge/platform/build/project"
import { Stage } from "@arcforge/platform/build/project/bundle/stage"

/**
 * README assets — what `axon publish` will ship, and what it refuses.
 *
 * These bytes end up on a page we serve, addressed by a URL that lives forever
 * in an immutable published version. So the refusals matter more than the happy
 * path: an asset that should not have shipped cannot be unshipped, only
 * superseded.
 *
 * Behaviour only — a project directory in, a report and a staged tree out.
 */

/** A real 2x2 PNG. sharp must be able to decode it, so it cannot be a stub. */
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==",
    "base64",
)

async function project(files: Record<string, Buffer | string> = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-assets-"))
    for (const [path, content] of Object.entries(files)) {
        const target = join(root, path)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, content)
    }
    return root
}

async function bundleDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "axon-assets-bundle-"))
}

describe("assets: what ships", () => {
    test("a project with no assets folder publishes nothing and does not fail", async () => {
        const root = await project()
        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        expect(result.tarball).toBeNull()
        expect(result.assets).toEqual([])
        expect(result.total).toBe(0)
    })

    test("an empty assets folder is the same as no folder", async () => {
        const root = await project()
        await mkdir(join(root, "assets"), { recursive: true })

        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        expect(result.tarball).toBeNull()
        expect(result.assets).toEqual([])
    })

    /**
     * The filename must survive compression.
     *
     * A README references `./assets/shot.png` literally, and the site resolves
     * that exact path against storage. An earlier version converted to WebP and
     * renamed the file, which 404'd every compressed image on the site — so this
     * is a regression test, not a preference.
     */
    test("compression never renames the file", async () => {
        const root = await project({ "assets/shot.png": PNG_1X1 })

        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        expect(result.assets).toHaveLength(1)
        expect(result.assets[0]!.path).toBe("assets/shot.png")
        expect(result.assets[0]!.original).toBe(PNG_1X1.byteLength)
    })

    test("every staged filename matches what the report claims shipped", async () => {
        const root = await project({
            "assets/a.png": PNG_1X1,
            "assets/b.jpg": PNG_1X1,
            "assets/c.mp4": Buffer.alloc(512),
        })

        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        // What a README would reference is exactly what exists on disk.
        expect(result.assets.map(a => a.path).sort())
            .toEqual(["assets/a.png", "assets/b.jpg", "assets/c.mp4"])
    })

    test("assets are packaged as their OWN archive, never into source.tar.gz", async () => {
        const root = await project({ "assets/shot.png": PNG_1X1 })
        const bundle = await bundleDir()

        const result = await Assets({ root, stage: Stage({ root }) }).collect(bundle)

        // The whole point of the separation: a distinct artifact, off the
        // install path, named so publish can send it as its own part.
        expect(result.tarball).toBe(join(bundle, "assets.tar.gz"))
        expect(await Bun.file(result.tarball!).exists()).toBe(true)

        // Members are `assets/<path>` — no npm `package/` prefix, since nothing
        // installs this archive.
        const listing = await Bun.$`tar -tzf ${result.tarball!}`.quiet()
        expect(listing.stdout.toString()).toContain("assets/shot.png")

        // Publishing must never rewrite source.
        expect(await readdir(join(root, "assets"))).toEqual(["shot.png"])
    })

    test("the staging tree is cleaned up — no second copy of every asset left behind", async () => {
        const root = await project({ "assets/shot.png": PNG_1X1 })
        const bundle = await bundleDir()

        await Assets({ root, stage: Stage({ root }) }).collect(bundle)

        // `.assets/` exists only to be tarred. Left behind it would be a stale
        // duplicate of every asset after the author's next edit.
        expect(await readdir(bundle)).toEqual(["assets.tar.gz"])
    })

    test("nested folders keep their shape", async () => {
        const root = await project({ "assets/shots/deep/a.png": PNG_1X1 })

        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        expect(result.assets).toHaveLength(1)
        expect(result.assets[0]!.path).toBe("assets/shots/deep/a.png")
    })

    test("video is published untouched — no transcode, so no ffmpeg dependency", async () => {
        const video = Buffer.alloc(2048, 7)
        const root = await project({ "assets/demo.mp4": video })

        const result = await Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())

        expect(result.assets).toEqual([
            { path: "assets/demo.mp4", original: 2048, final: 2048, compressed: false },
        ])
    })
})

describe("assets: what is refused", () => {
    test("SVG is refused — it is an executable document served from our origin", async () => {
        const root = await project({ "assets/logo.svg": "<svg onload=\"alert(1)\"/>" })

        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow(/SVG/i)
    })

    test("an unsupported extension is refused rather than published as bytes", async () => {
        const root = await project({ "assets/tool.exe": "MZ" })

        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow(/unsupported extension/i)
    })

    test("a file that is not the image its name claims is refused, not shipped broken", async () => {
        const root = await project({ "assets/broken.png": "definitely not a png" })

        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow(/decoded/i)
    })

    test("a symlink is refused — following it would publish bytes from outside the project", async () => {
        const root = await project()
        await mkdir(join(root, "assets"), { recursive: true })
        const secret = join(root, "secret.png")
        await writeFile(secret, PNG_1X1)
        await symlink(secret, join(root, "assets", "link.png"))

        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow(/symlink/i)
    })

    test("a single oversized asset is refused before it can be decoded", async () => {
        // Over the 10MB per-asset ceiling. Raised from 5MB once assets came off
        // the install path — a big video now costs only the page's viewer.
        const root = await project({ "assets/huge.mp4": Buffer.alloc(11 * 1024 * 1024) })

        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow(/max/i)
    })

    test("assets that individually fit but together exceed the budget are refused", async () => {
        // Each under the 10MB per-asset cap; together over the 25MB total.
        const root = await project({
            "assets/a.mp4": Buffer.alloc(9 * 1024 * 1024),
            "assets/b.mp4": Buffer.alloc(9 * 1024 * 1024),
            "assets/c.mp4": Buffer.alloc(9 * 1024 * 1024),
        })

        // Asserted on the stable error code rather than the message prose: the
        // wording is a rendering detail, the code is the contract.
        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir()))
            .rejects.toMatchObject({ code: "AX-PROJECT-040" })
    })

    test("nothing is uploaded-shaped on refusal — a rejected collect reports no assets", async () => {
        const root = await project({
            "assets/fine.png": PNG_1X1,
            "assets/bad.exe": "MZ",
        })

        // The throw is the assertion: a partial result would mean publish could
        // proceed with half an asset set.
        await expect(Assets({ root, stage: Stage({ root }) }).collect(await bundleDir())).rejects.toThrow()
    })
})
