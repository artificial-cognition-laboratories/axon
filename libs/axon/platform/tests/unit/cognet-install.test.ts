import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cognet } from "@arcforge/platform/build/blueprint"

const ZERO_SOURCE = resolve(import.meta.dir, "../../../../../registry/cognets/zero")
/**
 * Where a workspace package's source actually lives. Bun links workspace deps
 * into the CONSUMING package's node_modules rather than the repo root, so the
 * test resolves them from source instead of guessing at a link location.
 */
const WORKSPACE_PACKAGES: Record<string, string> = {
    "@arcforge/cognet": resolve(import.meta.dir, "../../../../../libs/axon/cognet"),
    "@arcforge/types": resolve(import.meta.dir, "../../../../../libs/axon/types"),
    "@arcforge/err": resolve(import.meta.dir, "../../../../../libs/axon/packages/err"),
    "@arcforge/engines": resolve(import.meta.dir, "../../../../../libs/axon/packages/engines"),
    "@arcforge/air": resolve(import.meta.dir, "../../../../../libs/axon/packages/air"),
    // Not a workspace package — a real npm dependency, staged from this
    // package's own installed copy. Same resolution shape as the others: a
    // link to a tree that resolves ITS own deps the way it does in production.
    h3: resolve(import.meta.dir, "../../node_modules/h3"),
}

/**
 * Compiling a cognet the way an AGENT does — resolved out of node_modules,
 * not out of this workspace.
 *
 * This is the gap that shipped a broken @axon/zero: its source imported AIR by
 * a deep relative path (`../../../../core/src/platform/air`) that resolved
 * fine from the workspace and pointed nowhere once installed. Every check
 * passed locally; every agent failed to compile its brain.
 *
 * So these tests deliberately never bundle from the source tree. They stage a
 * cognet into a real node_modules layout first, which is the only arrangement
 * that can catch an import a published package cannot resolve.
 */
describe("cognet install", () => {
    /**
     * Symlink every package the installed cognet declares into the agent's
     * tree, mirroring what `bun install` materializes. Reading them off the
     * cognet's own manifest means a NEW dependency is covered automatically —
     * the test can't silently stop checking the thing it exists to check.
     */
    /**
     * Link one workspace package into the agent's tree. The link points at the
     * package's real location, so it resolves ITS own deps exactly as it does
     * in production.
     */
    async function linkPackage(agent: string, name: string): Promise<void> {
        const source = WORKSPACE_PACKAGES[name]
        if (!source) {
            throw new Error(
                `cognet-install test: nothing staged for "${name}". `
                + `Add it to WORKSPACE_PACKAGES so the install path stays covered.`,
            )
        }
        const target = join(agent, "node_modules", ...name.split("/"))
        if (existsSync(target)) return
        await mkdir(join(target, ".."), { recursive: true })
        await symlink(source, target, "dir")
    }

    async function linkDependencies(agent: string): Promise<void> {
        const manifestPath = join(agent, "node_modules", "@axon", "zero", "package.json")
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as { dependencies?: Record<string, string> }
        for (const name of Object.keys(manifest.dependencies ?? {})) {
            await linkPackage(agent, name)
        }
    }

    /** Stage `zero` into <agent>/node_modules/@axon/zero, as an install would. */
    async function installZero(agent: string): Promise<void> {
        const target = join(agent, "node_modules", "@axon", "zero")
        await mkdir(target, { recursive: true })
        // Exactly what the published tarball carries — see zero's package.json "files".
        for (const entry of ["cognet.config.ts", "src", "plugins", "package.json"]) {
            await cp(join(ZERO_SOURCE, entry), join(target, entry), { recursive: true })
        }
    }

    test("compiles the reference cognet resolved from node_modules", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-cognet-install-"))
        const agent = join(root, "agent")
        try {
            await mkdir(agent, { recursive: true })
            await writeFile(join(agent, "package.json"), JSON.stringify({ name: "test-agent", version: "0.0.0" }))
            await installZero(agent)
            // The generated entry imports @arcforge/cognet by bare specifier,
            // so the runtime must resolve from the agent's tree even when the
            // cognet itself doesn't list it.
            await linkPackage(agent, "@arcforge/cognet")

            // The cognet's own dependencies must resolve from the agent's tree.
            // A real `bun install` fetches them; here they're symlinked out of
            // the workspace, which is the same resolution shape at no cost.
            await linkDependencies(agent)

            const sourceDir = Cognet({ root: agent }).sourceDir({ kind: "registry", specifier: "@axon/zero" })
            expect(sourceDir).toBe(join(agent, "node_modules", "@axon", "zero"))

            const { blueprint } = await Cognet({ root: agent }).compile({ kind: "source", dir: sourceDir })

            // The SCOPED identity, as the cognet's own package.json declares
            // it — not the directory it happens to sit in. A bare "zero"
            // could belong to any publisher.
            expect(blueprint.name).toBe("@axon/zero")
            expect(blueprint.abi).toBeString()
            expect(blueprint.hash).toBeString()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 120_000)

    test("sourceDir refuses a cognet that isn't installed", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-cognet-missing-"))
        try {
            await mkdir(root, { recursive: true })
            expect(() => Cognet({ root }).sourceDir({ kind: "registry", specifier: "@axon/nope" })).toThrow()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("sourceDir refuses an unscoped specifier", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-cognet-unscoped-"))
        try {
            // "zero" was the old built-in name. Cognets are registry artifacts
            // now, so a bare name can never resolve and must fail loudly.
            expect(() => Cognet({ root }).sourceDir({ kind: "registry", specifier: "zero" })).toThrow()
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
