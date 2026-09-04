import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-module-${crypto.randomUUID().slice(0, 8)}`
}

describe("module project: bundle()", () => {
    it("writes a real image.json with identity from package.json", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const { image, tarball } = await project.bundle()
            if (image.kind !== "module") throw new Error("expected a module image")

            expect(image.moduleId).toBe(name)
            expect(image.version).toBe("0.1.0")
            expect(Number.isNaN(Date.parse(image.builtAt))).toBe(false)
            expect(tarball).toBe(join(project.root, ".module", "build", "source.tar.gz"))
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("scaffolded modules default to private:false in package.json, so the bundle is public", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const { image } = await project.bundle()
            expect(image.public).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("public becomes true once package.json's private flag is removed", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const pkgPath = join(project.root, "package.json")
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
            delete pkg.private
            await writeFile(pkgPath, JSON.stringify(pkg, null, 2))

            const { image } = await project.bundle()
            expect(image.public).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes a manifest.json with tools/scripts scan results", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            await project.bundle()
            const manifest = JSON.parse(
                await readFile(join(project.root, ".module", "build", "manifest.json"), "utf-8")
            )

            expect(manifest.name).toBe(name)
            expect(manifest.kind).toBe("module")
            expect(Array.isArray(manifest.tools)).toBe(true)
            expect(Array.isArray(manifest.scripts)).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("preserves prepared types when writing publish artifacts", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })
            await project.prepare()

            // The generated types, which publish must leave untouched. They
            // live in the frame's types/ area while the bundle writes into
            // build/, so the two can no longer collide by construction — this
            // guards that separation rather than a name-by-name clear list.
            const typeDir = join(project.root, ".module", "types")
            const axonDts = await readFile(join(typeDir, "axon.d.ts"), "utf-8")
            const tsconfig = await readFile(join(typeDir, "tsconfig.json"), "utf-8")

            await project.bundle()

            expect(await readFile(join(typeDir, "axon.d.ts"), "utf-8")).toBe(axonDts)
            expect(await readFile(join(typeDir, "tsconfig.json"), "utf-8")).toBe(tsconfig)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("produces a real, non-empty tarball containing module.config.ts", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })

            const { tarball } = await project.bundle()
            const bytes = await readFile(tarball)
            expect(bytes.byteLength).toBeGreaterThan(0)

            const listing = await Bun.$`tar -tzf ${tarball}`.quiet().text()
            expect(listing).toContain("module.config.ts")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("throws BUNDLE_INVALID when package.json is missing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("module", { name, dir })
            await rm(join(project.root, "package.json"))

            await expect(project.bundle()).rejects.toThrow(/no package\.json/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
