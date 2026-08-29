import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { verifyArtifact } from "@arcforge/platform/build/project/publish/verify"

/**
 * The gate that stops an uncompilable artifact reaching the registry.
 *
 * These reproduce the exact defect that shipped: a cognet whose `src/main.ts`
 * imports a root-level `../config` that the packager did not include. The
 * tarball was valid, the registry accepted it, resolution and download both
 * worked — and it failed only at compile time on a consumer's machine.
 *
 * The important case is the FIRST one. A verification step that only rejects
 * obvious garbage is theatre; this one has to reject an artifact that looks
 * entirely well-formed and is merely incomplete.
 */

/**
 * An agent root the compile can resolve @arcforge/cognet from.
 *
 * Nested INSIDE this package rather than in /tmp: bundleCognet walks up from
 * agentRoot looking for the installed runtime, exactly as a resolver would, so
 * a directory under libs/axon/platform inherits the workspace's node_modules —
 * including the runtime's own transitive deps, which a bare symlink into the
 * source tree would not provide.
 */
async function withAgentRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(resolve(import.meta.dir, "../.."), "axon-verify-agent-"))
    try {
        return await fn(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

/** Package `files` into an npm-format tarball and return its path. */
async function tarballOf(files: Record<string, string>): Promise<{ tarball: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "axon-verify-src-"))
    const pkg = join(dir, "package")

    for (const [path, content] of Object.entries(files)) {
        const full = join(pkg, path)
        await mkdir(join(full, ".."), { recursive: true })
        await writeFile(full, content, "utf8")
    }

    const tarball = join(dir, "source.tar.gz")
    await Bun.spawn(["tar", "-czf", tarball, "-C", dir, "package"]).exited

    return { tarball, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const CONFIG = `export default defineCognet({ name: "probe", version: "1.0.0", abi: "9", mode: { kind: "invocation" } })`

describe("publish verification", () => {
    test("REJECTS a cognet whose imported file was left out of the package", async () => {
        // The shipped bug, exactly: main.ts imports ../config, config.ts is
        // absent from the tarball. Everything else about the package is fine.
        const { tarball, cleanup } = await tarballOf({
            "package.json": JSON.stringify({ name: "@t/probe", version: "1.0.0" }),
            "cognet.config.ts": CONFIG,
            "src/main.ts": `import { brain } from "../config"\nloop(async ({ stop }) => { void brain; stop() })`,
        })

        try {
            await withAgentRoot(async root => {
                const attempt = verifyArtifact({ kind: "cognet", tarball, root, name: "@t/probe" })
                await expect(attempt).rejects.toThrow()
            })
        } finally {
            await cleanup()
        }
    }, 60_000)

    test("ACCEPTS the same cognet once the imported file ships", async () => {
        // The control. Identical but for config.ts being present — so a pass
        // here proves the rejection above is about the missing file and not
        // some unrelated failure in the harness.
        const { tarball, cleanup } = await tarballOf({
            "package.json": JSON.stringify({ name: "@t/probe", version: "1.0.0" }),
            "cognet.config.ts": CONFIG,
            "config.ts": `export const brain = { cruise: 1 }`,
            "src/main.ts": `import { brain } from "../config"\nloop(async ({ stop }) => { void brain; stop() })`,
        })

        try {
            await withAgentRoot(async root => {
                await verifyArtifact({ kind: "cognet", tarball, root, name: "@t/probe" })
            })
        } finally {
            await cleanup()
        }
    }, 60_000)

    test("skips kinds with no source a consumer compiles", async () => {
        // Agents ship a pre-built image, so a build failure surfaced long
        // before this point; prompts are text with no build step at all.
        // Verifying either would mean inventing a second notion of "valid".
        await verifyArtifact({ kind: "agent", tarball: "/nonexistent", root: "/nonexistent", name: "@t/a" })
        await verifyArtifact({ kind: "prompt", tarball: "/nonexistent", root: "/nonexistent", name: "@t/p" })
    })
})

/**
 * Modules are verified too, and for the same reason cognets are.
 *
 * A module's `src/tools/*.ts` are SOURCE the installing agent compiles: the
 * scanner runs declareTools() over them to build the tool scope. Publishing
 * never exercised that, so @axon/arxiv@0.1.4 shipped with `QueryOptions` used
 * in an exported signature and never re-exported — accepted by the registry,
 * resolvable, downloadable, and impossible to install. The only place it could
 * fail was a user's terminal, against a version that can no longer be changed.
 */
describe("publish verification: module tools", () => {
    test("REJECTS a module whose tool signature names an unresolvable type", async () => {
        // The shipped bug, exactly: the tool imports a type from a sibling
        // file that is not in the tarball. Everything else is well-formed.
        const { tarball, cleanup } = await tarballOf({
            "package.json": JSON.stringify({ name: "@t/mod", version: "1.0.0" }),
            "module.config.ts": `export default defineModule({})`,
            "src/tools/query.ts":
                `import type { QueryOptions } from "../types"\n`
                + `export function search(opts: QueryOptions): string { return String(opts) }\n`,
        })

        try {
            await withAgentRoot(async root => {
                const attempt = verifyArtifact({ kind: "module", tarball, root, name: "@t/mod" })
                await expect(attempt).rejects.toThrow()
            })
        } finally {
            await cleanup()
        }
    }, 60_000)

    test("ACCEPTS the same module once the type ships", async () => {
        // The control — identical but for types.ts being present, so the
        // rejection above is about the missing definition and not the harness.
        const { tarball, cleanup } = await tarballOf({
            "package.json": JSON.stringify({ name: "@t/mod", version: "1.0.0" }),
            "module.config.ts": `export default defineModule({})`,
            "src/types.ts": `export type QueryOptions = { q: string }\n`,
            "src/tools/query.ts":
                `import type { QueryOptions } from "../types"\n`
                + `export function search(opts: QueryOptions): string { return String(opts) }\n`,
        })

        try {
            await withAgentRoot(async root => {
                await verifyArtifact({ kind: "module", tarball, root, name: "@t/mod" })
            })
        } finally {
            await cleanup()
        }
    }, 60_000)

    test("ACCEPTS a module that ships no tools at all", async () => {
        // Plenty of modules are routes, plugins or prompts. Having nothing to
        // declare is not a defect, and a gate that rejected it would block
        // perfectly good artifacts.
        const { tarball, cleanup } = await tarballOf({
            "package.json": JSON.stringify({ name: "@t/mod", version: "1.0.0" }),
            "module.config.ts": `export default defineModule({})`,
        })

        try {
            await withAgentRoot(async root => {
                await verifyArtifact({ kind: "module", tarball, root, name: "@t/mod" })
            })
        } finally {
            await cleanup()
        }
    }, 60_000)
})
