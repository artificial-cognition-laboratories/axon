import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bundle } from "../../src/registry/artifacts"

/**
 * Where Bundle() looks for the files it publishes.
 *
 * This exists because the two shapes it has to satisfy are genuinely
 * different, and nothing else catches a mismatch until someone runs `axon
 * publish` against a real registry:
 *
 *   module → package.json is copied INTO the bundle directory
 *   agent  → package.json stays at the PROJECT ROOT, two levels above the
 *            bundle directory (`<root>/.agent/build/`)
 *
 * The agent case regressed exactly once: the bundle moved from `.agent/` into
 * `.agent/build/`, the upward search still walked a single level, and every
 * agent publish died with "no package.json at .agent/build/…". The suite was
 * green throughout, because every test that would have exercised this path
 * needed a live authenticated registry.
 *
 * So these assert the LAYOUT only — no network, no auth, no staging. They
 * fail in milliseconds on a machine with nothing running.
 */

const TARBALL = "source.tar.gz"

/** A directory that looks like what a bundler left behind. */
async function bundleDir(shape: "agent" | "module"): Promise<{ root: string; dir: string }> {
    const root = await mkdtemp(join(tmpdir(), "axon-bundle-layout-"))

    const frame = shape === "agent" ? ".agent" : ".module"
    const dir = join(root, frame, "build")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, TARBALL), "not-a-real-tarball")
    await writeFile(join(dir, "image.json"), JSON.stringify({ kind: shape }))

    const pkg = JSON.stringify({ name: `@test/${shape}`, version: "1.2.3" })
    if (shape === "module") {
        // A module's bundler copies the manifest in beside the tarball.
        await writeFile(join(dir, "package.json"), pkg)
    } else {
        // An agent's stays at the project root — the frame holds generated
        // output and the deploy image, never a manifest.
        await writeFile(join(root, "package.json"), pkg)
    }

    return { root, dir }
}

describe("registry.artifacts: bundle layout", () => {
    it("reads an agent's package.json from the project root, two levels above the bundle", async () => {
        const { root, dir } = await bundleDir("agent")
        try {
            const bundle = await Bundle(dir)

            expect(JSON.parse(bundle.config).name).toBe("@test/agent")
            expect(bundle.version).toBe("1.2.3")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("reads a module's package.json from inside the bundle directory", async () => {
        const { root, dir } = await bundleDir("module")
        try {
            const bundle = await Bundle(dir)

            expect(JSON.parse(bundle.config).name).toBe("@test/module")
            expect(bundle.version).toBe("1.2.3")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("picks up tool-globals.d.ts from the frame's types/ area", async () => {
        const { root, dir } = await bundleDir("agent")
        try {
            // typegen writes the published tool surface here — a sibling of
            // build/, not inside it.
            const types = join(root, ".agent", "types")
            await mkdir(types, { recursive: true })
            await writeFile(join(types, "tool-globals.d.ts"), "declare const x: 1\n")

            const bundle = await Bundle(dir)

            expect(bundle.manifest).toContain("declare const x")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("treats an absent tool surface as no manifest, never an error", async () => {
        const { root, dir } = await bundleDir("agent")
        try {
            // A project with no tools publishes no declarations. That is a
            // real state, not a broken bundle.
            const bundle = await Bundle(dir)

            expect(bundle.manifest).toBeNull()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("fails loudly when no package.json exists anywhere above the bundle", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-bundle-layout-"))
        try {
            const dir = join(root, ".agent", "build")
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, TARBALL), "not-a-real-tarball")

            await expect(Bundle(dir)).rejects.toThrow(/package\.json/)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
