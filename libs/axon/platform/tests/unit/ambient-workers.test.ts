import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hostile } from "../setup/hostile"

/**
 * Code that resolves a path must not read the environment to do it.
 *
 * ── Why these assert on SOURCE ──────────────────────────────────────────────
 *
 * The workers here are spawned, not called, so a behavioural test would need a
 * real `bun` on PATH — which is the very thing a hostile environment removes.
 * The property worth pinning is structural and holds without running anything:
 * a worker's location is derived from `import.meta.dir` (module-relative, and
 * therefore correct wherever the process was launched from) rather than from
 * `process.cwd()` or an env var.
 *
 * That distinction is exactly what the TMPDIR bug turned on. `import.meta.dir`
 * survives a process boundary; `os.tmpdir()` does not, because it reads an env
 * var the agent's environment does not carry. Both look like "resolve a path"
 * at the call site.
 */

const SRC = join(import.meta.dir, "..", "..", "src")

function source(relative: string): string {
    return readFileSync(join(SRC, relative), "utf-8")
}

/** Worker entry points, and the module that spawns each. */
const WORKERS = [
    "build/blueprint/scan/tools.ts",
    "build/blueprint/cognet/bundle.ts",
]

describe("worker path resolution", () => {
    it("derives every worker path from import.meta.dir", () => {
        // The published CLI is one file with the workers bundled beside it, so
        // a cwd-relative path resolves to wherever the user happened to be
        // standing. Getting this wrong is silent in development and total in
        // production — every tool declaration in every installed agent fails.
        for (const file of WORKERS) {
            const text = source(file)
            const paths = [...text.matchAll(/const \w*WORKER_PATH\w* = [\s\S]*?\n\n/g)].join("")
            expect(text).toContain("import.meta.dir")
            expect(paths).not.toContain("process.cwd()")
            expect(paths).not.toContain("process.env")
        }
    })

    it("resolves worker paths without consulting the environment", async () => {
        // Importing the module evaluates its module-level path constants. Under
        // a hostile environment that must still succeed: if resolution read
        // TMPDIR, HOME or PWD, the decoys would send it somewhere that does not
        // exist and the import would throw.
        await hostile(async () => {
            const mod = await import("../../src/build/blueprint/scan/tools")
            expect(mod).toBeDefined()
        })
    })
})

describe("spawned binaries", () => {
    /**
     * `find` is not on Windows, and `spawnSync` reports its absence as empty
     * stdout — indistinguishable from "no matches". Two call sites in tree.ts
     * looped over that nothing and returned null, so "this machine has no
     * find" read as "this workspace has no framework packages": a developer on
     * a Mac linked against the published copy while believing they were
     * testing their checkout.
     *
     * Now an in-process directory walk, which has no binary to be absent. The
     * guard is that it stays that way — reaching for a shell utility here
     * reintroduces both the portability gap and the silent-failure mode.
     */
    it("resolves workspace packages without shelling out", () => {
        const text = source("build/project/tree.ts")
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "")

        expect(code).not.toContain("Bun.spawnSync")
        expect(code).toContain("manifestsUnder")
    })

})
