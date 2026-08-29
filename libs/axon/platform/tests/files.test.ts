import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Files } from "../src/services/files"

/**
 * The working-tree index behind the TUI's `@` palette.
 *
 * Driven entirely through the public handle against a real directory — the
 * ignore rules and the walk bounds are only meaningful as observed behaviour on
 * a filesystem, and mocking one would test the mock.
 *
 * The ignore cases are the ones that matter most: this shipped once discarding
 * every `**&#47;name` pattern, which is how nearly all real gitignores are written,
 * and the walk consequently descended a 29G tree and hung the terminal.
 */

let root: string

async function tree(spec: Record<string, string>): Promise<void> {
    for (const [path, contents] of Object.entries(spec)) {
        const full = join(root, path)
        await mkdir(join(full, ".."), { recursive: true })
        await writeFile(full, contents)
    }
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "axon-files-"))
})

afterEach(async () => {
    await rm(root, { recursive: true, force: true })
})

describe("Files", () => {
    it("lists files and directories relative to the root", async () => {
        await tree({ "src/index.ts": "", "README.md": "" })

        const paths = (await Files({ root }).list()).map(entry => entry.path).sort()
        expect(paths).toEqual(["README.md", "src", "src/index.ts"])
    })

    it("marks directories, so the palette can descend them", async () => {
        await tree({ "src/index.ts": "" })

        const entries = await Files({ root }).list()
        expect(entries.find(entry => entry.path === "src")?.directory).toBe(true)
        expect(entries.find(entry => entry.path === "src/index.ts")?.directory).toBe(false)
    })

    it("always skips dependency trees, even when nothing ignores them", async () => {
        await tree({
            "node_modules/pkg/index.js": "",
            ".venv/lib/mod.py": "",
            "target/debug/bin": "",
            "src/main.ts": "",
        })

        const paths = (await Files({ root }).list()).map(entry => entry.path)
        expect(paths).toEqual(expect.arrayContaining(["src", "src/main.ts"]))
        for (const skipped of ["node_modules", ".venv", "target"]) {
            expect(paths.some(path => path.startsWith(skipped))).toBe(false)
        }
    })

    it("honours a bare gitignore name at any depth", async () => {
        await tree({
            ".gitignore": "dist\n",
            "dist/out.js": "",
            "apps/web/dist/out.js": "",
            "apps/web/src/app.ts": "",
        })

        const paths = (await Files({ root }).list()).map(entry => entry.path)
        expect(paths).toContain("apps/web/src/app.ts")
        expect(paths.some(path => path.includes("dist"))).toBe(false)
    })

    it("honours the `**/name` form — the dominant real-world idiom", async () => {
        // The regression that hung the TUI: these were discarded as "globs",
        // so every build directory in the tree was walked and listed.
        await tree({
            ".gitignore": "**/.output\n**/build/\n**/coverage/**\n",
            "apps/api/.output/server.js": "",
            "apps/api/build/main.js": "",
            "apps/api/coverage/report.html": "",
            "apps/api/src/api.ts": "",
        })

        const paths = (await Files({ root }).list()).map(entry => entry.path)
        expect(paths).toContain("apps/api/src/api.ts")
        for (const ignored of [".output", "build", "coverage"]) {
            expect(paths.some(path => path.includes(ignored))).toBe(false)
        }
    })

    it("honours a root-anchored path without ignoring the same name elsewhere", async () => {
        await tree({
            ".gitignore": "/apps/web/cache\n",
            "apps/web/cache/x": "",
            "apps/api/cache/y": "",
        })

        const paths = (await Files({ root }).list()).map(entry => entry.path)
        expect(paths).toContain("apps/api/cache/y")
        expect(paths).not.toContain("apps/web/cache/x")
    })

    it("ignores comments and negations rather than treating them as names", async () => {
        await tree({ ".gitignore": "# a comment\n!keep\n", "keep/file.ts": "", "# a comment": "" })

        const paths = (await Files({ root }).list()).map(entry => entry.path)
        expect(paths).toContain("keep/file.ts")
    })

    it("reports truncation instead of silently returning a partial index", async () => {
        await tree(Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [`src/file-${i}.ts`, ""]),
        ))

        const files = Files({ root, maxEntries: 10 })
        const entries = await files.list()

        expect(entries.length).toBeLessThanOrEqual(10)
        expect(files.truncated).toBe(true)
    })

    it("reports a complete walk as untruncated", async () => {
        await tree({ "src/a.ts": "", "src/b.ts": "" })

        const files = Files({ root })
        await files.list()
        expect(files.truncated).toBe(false)
    })

    it("holds the index until invalidated — a re-walk is never spontaneous", async () => {
        // The property the TUI's reactive caller depends on: repeated list()
        // calls do no work and return the same index, so calling it from a
        // computed cannot drive a render loop.
        await tree({ "a.ts": "" })
        const files = Files({ root })

        const first = await files.list()
        await tree({ "b.ts": "" })
        const second = await files.list()

        expect(second).toBe(first)
        expect(second.map(entry => entry.path)).toEqual(["a.ts"])
    })

    it("bounds the walk by depth", async () => {
        await tree({ "a/b/c/d/deep.ts": "", "top.ts": "" })

        const paths = (await Files({ root, maxDepth: 2 }).list()).map(entry => entry.path)
        expect(paths).toContain("top.ts")
        expect(paths).not.toContain("a/b/c/d/deep.ts")
    })

    it("serves children of one directory", async () => {
        await tree({ "src/a.ts": "", "src/nested/b.ts": "", "other.ts": "" })

        const children = await Files({ root }).children("src")
        expect(children.map(entry => entry.path).sort()).toEqual(["src/a.ts", "src/nested"])
    })

    it("shares one walk across concurrent callers", async () => {
        await tree({ "src/a.ts": "" })
        const files = Files({ root })

        const [first, second] = await Promise.all([files.list(), files.list()])
        // Same walk, so the same array instance is handed to both.
        expect(first).toBe(second)
    })

    it("re-walks after invalidate, picking up a new file", async () => {
        await tree({ "a.ts": "" })
        const files = Files({ root })
        expect((await files.list()).map(e => e.path)).toEqual(["a.ts"])

        await tree({ "b.ts": "" })
        files.invalidate()

        expect((await files.list()).map(e => e.path).sort()).toEqual(["a.ts", "b.ts"])
    })

    it("survives an unreadable directory rather than failing the whole walk", async () => {
        await tree({ "readable/file.ts": "", "locked/hidden.ts": "" })
        await Bun.$`chmod 000 ${join(root, "locked")}`.quiet()

        try {
            const paths = (await Files({ root }).list()).map(entry => entry.path)
            expect(paths).toContain("readable/file.ts")
            expect(paths).toContain("locked")
        } finally {
            await Bun.$`chmod 755 ${join(root, "locked")}`.quiet()
        }
    })
})
