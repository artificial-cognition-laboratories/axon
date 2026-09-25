import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Tree } from "@arcforge/platform/build/project"

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("Tree — the project's installed node_modules", () => {
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
