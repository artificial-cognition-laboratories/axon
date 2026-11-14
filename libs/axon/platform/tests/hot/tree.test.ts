import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Tree, TreeCache } from "@arcforge/platform/build/project"

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("Tree — the project's installed node_modules", () => {
    test("a cache hit links .bin into the project", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-dependency-graft-"))
        roots.push(root)
        const project = join(root, "project")
        const staging = join(root, "staging")
        const cacheRoot = join(root, "cache")
        const cache = TreeCache({ root: cacheRoot })
        await Promise.all([
            mkdir(project, { recursive: true }),
            mkdir(join(staging, "node_modules", ".bin"), { recursive: true }),
        ])
        const manifest = JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} })
        await Promise.all([
            writeFile(join(project, "package.json"), manifest),
            writeFile(join(staging, "package.json"), manifest),
            writeFile(join(staging, "node_modules", ".bin", "probe"), "works"),
        ])
        await cache.publish((await cache.key(staging))!, staging)

        await Tree({ root: project, cache: { root: cacheRoot } }).install()

        const link = join(project, "node_modules", ".bin")
        expect((await lstat(link)).isSymbolicLink()).toBe(true)
        expect(await readFile(join(link, "probe"), "utf8")).toBe("works")
    })

    test("package binaries survive removal of Bun's isolated install directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-dependency-copy-"))
        roots.push(root)
        const staging = join(root, "staging", "node_modules")
        const target = join(root, "agent", "node_modules")
        const executable = join(staging, "parser", "bin", "parser.js")
        await Promise.all([
            mkdir(join(staging, ".bin"), { recursive: true }),
            mkdir(join(staging, "parser", "bin"), { recursive: true }),
        ])
        await writeFile(executable, "parser fixture\n")
        await symlink(executable, join(staging, ".bin", "parser"))

        await Tree({ root }).materialize(staging, target)
        await rm(join(root, "staging"), { recursive: true, force: true })

        expect(await readFile(join(target, ".bin", "parser"), "utf-8")).toBe("parser fixture\n")
    })
})
