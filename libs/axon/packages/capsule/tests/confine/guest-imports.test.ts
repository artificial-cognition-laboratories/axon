import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The confinement import boundary, enforced.
 *
 * Everything under src/process/ runs INSIDE the sandbox subprocess, whose
 * filesystem is exactly what the fs policy declares and nothing more. A
 * workspace package resolves through a symlink pointing out of the box
 * (node_modules/@arcforge/err -> ../../../err), so a runtime import of one
 * makes the subprocess die at startup with ENOENT — confinement working as
 * designed, not a packaging bug.
 *
 * Nothing about that is visible while writing the code. It type-checks, it
 * reads like ordinary source, and it fails only when a real confined
 * subprocess is spawned — which is how it slipped in once already. This
 * test turns that silent runtime death into an ordinary test failure.
 *
 * The rule: guest code may import node builtins and TYPE-ONLY declarations
 * (erased at compile time, never reaching the module resolver). Nothing else.
 */

const GUEST_DIR = join(import.meta.dir, "../../src/process")

/** Every .ts file under src/process/, recursively. */
async function guestFiles(dir: string): Promise<string[]> {
    const found: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) found.push(...await guestFiles(path))
        else if (entry.name.endsWith(".ts")) found.push(path)
    }
    return found
}

/**
 * Import statements that survive compilation — `import type` and inline
 * `type` specifiers are erased, so they never hit the resolver and are
 * always safe.
 */
function runtimeImports(source: string): string[] {
    const specifiers: string[] = []
    // matches: import ... from "x"  /  import "x"  /  export ... from "x"
    const pattern = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g

    for (const match of source.matchAll(pattern)) {
        const clause = match[1] ?? ""
        const specifier = match[2] ?? match[3]
        if (!specifier) continue
        // `import type { X } from` — fully erased
        if (/^\s*type\s/.test(clause)) continue
        specifiers.push(specifier)
    }
    return specifiers
}

/** node: builtins and relative paths inside the guest tree are fine. */
function isPermitted(specifier: string): boolean {
    return specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../")
}

describe("Guest import boundary", () => {
    it("imports nothing at runtime but node builtins and its own tree", async () => {
        const files = await guestFiles(GUEST_DIR)
        expect(files.length).toBeGreaterThan(0)

        const violations: string[] = []
        for (const file of files) {
            const source = await readFile(file, "utf8")
            for (const specifier of runtimeImports(source)) {
                if (!isPermitted(specifier)) {
                    violations.push(`${file.slice(GUEST_DIR.length + 1)} → ${specifier}`)
                }
            }
        }

        // A violation here does NOT fail typecheck and does NOT fail any test
        // that stubs the sandbox — it kills the real subprocess at startup.
        // See src/process/fault.ts for how to build what you need locally.
        expect(violations).toEqual([])
    })

    it("still allows type-only imports from workspace packages", async () => {
        // fault.ts is the reference: it imports AxonErrorJSON as a type from
        // @arcforge/types, which is correct and must keep passing.
        const source = await readFile(join(GUEST_DIR, "fault.ts"), "utf8")
        expect(source).toContain('import type { AxonErrorJSON')
        expect(runtimeImports(source).filter(s => !isPermitted(s))).toEqual([])
    })
})
