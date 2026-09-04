import { axonBaseRef } from "@arcforge/types"
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: bundle()", () => {
    it("writes a real image.json with identity from package.json", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const { image, tarball } = await project.bundle()
            if (image.kind !== "agent") throw new Error("expected an agent image")

            expect(image.agentId).toBe(name)
            expect(image.version).toBe("0.1.0")
            // A new agent declares private:false in package.json, which is
            // the bundle's sole visibility source of truth.
            expect(image.public).toBe(true)
            expect(typeof image.axonVersion).toBe("string")
            expect(Number.isNaN(Date.parse(image.builtAt))).toBe(false)
            expect(tarball).toBe(join(project.root, ".agent", "build", "source.tar.gz"))
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("writes image.json to disk at .agent/build/image.json, matching the returned image", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const { image } = await project.bundle()
            const onDisk = JSON.parse(await readFile(join(project.root, ".agent", "build", "image.json"), "utf-8"))

            expect(onDisk).toEqual(image)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("produces a real, non-empty tarball", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const { tarball } = await project.bundle()
            const bytes = await readFile(tarball)

            expect(bytes.byteLength).toBeGreaterThan(0)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("the tarball contains the scaffolded source files", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const { tarball } = await project.bundle()
            const listing = await Bun.$`tar -tzf ${tarball}`.quiet().text()

            expect(listing).toContain("axon.config.ts")
            expect(listing).toContain("package.json")
            expect(listing).toContain("src/boot.vue")
            expect(listing).toContain(".agent/cognet/cognet.mjs")
            expect(listing).toContain(".agent/cognet/manifest.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("ships an inline cognet's SOURCE alongside the compiled brain", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            // An inline brain: the folder IS the declaration, so nothing is
            // written into axon.config.ts.
            await mkdir(join(project.root, "cognet"), { recursive: true })
            await writeFile(join(project.root, "cognet", "main.ts"), "loop(async ({ stop }) => { stop() })\n")
            await project.prepare()

            const { tarball } = await project.bundle()
            const listing = await Bun.$`tar -tzf ${tarball}`.quiet().text()

            // Both, and for different readers. The compiled bundle is what a
            // deployed container executes; the source is what the registry
            // renders and what someone cloning the agent actually edits.
            // Shipping only the artifact published an agent whose thinking was
            // an opaque .mjs — it ran fine and was unreadable, which is why
            // this went unnoticed until it showed up as a missing folder in
            // the registry's file tree.
            expect(listing).toContain("cognet/main.ts")
            expect(listing).toContain(".agent/cognet/cognet.mjs")

            // The frame pointer is generated per-machine and regenerated by
            // prepare on the consumer's side — publishing it ships a path that
            // resolves to nothing until then.
            expect(listing).not.toContain("cognet/tsconfig.json")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("re-bundling replaces the previous .agent bundle rather than accumulating stale files", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            await project.bundle()
            await rm(join(project.root, "src", "boot.vue"))
            const { tarball } = await project.bundle()
            const listing = await Bun.$`tar -tzf ${tarball}`.quiet().text()

            expect(listing).not.toContain("boot.vue")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("includes a self-host Dockerfile and .dockerignore in the bundle and the tarball", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const { tarball } = await project.bundle()

            const dockerfile = await readFile(join(project.root, ".agent", "build", "Dockerfile"), "utf-8")
            // Pinned and PUBLIC. It read `axon-base:local` — an image in a private
            // registry no user could pull, so `docker build` on the emitted
            // Dockerfile failed with "pull access denied" and the self-host path
            // it advertised had never worked.
            expect(dockerfile).toContain(`FROM ${axonBaseRef()}`)
            expect(dockerfile).toContain("COPY . /agent")

            const dockerignore = await readFile(join(project.root, ".agent", "build", ".dockerignore"), "utf-8")
            expect(dockerignore).toContain("node_modules")

            // Tarball layout, NOT local layout. Locally these live in the
            // frame's build/ area; inside the bundle they sit directly under
            // .agent/ because that is what a deployed container resolves.
            // stageCognet() performs that remap deliberately — see agent.ts.
            const listing = await Bun.$`tar -tzf ${tarball}`.quiet().text()
            expect(listing).toContain(".agent/Dockerfile")
            expect(listing).toContain(".agent/.dockerignore")
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
            const project = await platform.projects.create("agent", { name, dir })
            await rm(join(project.root, "package.json"))

            await expect(project.bundle()).rejects.toThrow(/no package\.json/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
