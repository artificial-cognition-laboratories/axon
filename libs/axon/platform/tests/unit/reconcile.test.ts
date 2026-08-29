import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reconcile, Manifest, Tree } from "@arcforge/platform/build/project"

/**
 * Reconcile — the MANIFEST half of prepare: prune what is no longer declared,
 * write the ranges this run intends.
 *
 * It used to judge the installed tree as well. That half is now `tree.verify()`
 * (see tests/unit/project/verify.test.ts): two implementations of "is the tree
 * right" is exactly how they drift apart, and the tree question needed to be
 * askable on its own so `--frozen` and `axon doctor` could ask it too.
 *
 * What remains never installs and never inspects node_modules — it compares
 * the declaration against the manifest and repairs the manifest.
 */

async function project(files: {
    dependencies?: Record<string, string>
    installed?: Record<string, string | null>
}) {
    const root = await mkdtemp(join(tmpdir(), "axon-reconcile-"))

    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "probe", version: "1.0.0", dependencies: files.dependencies ?? {} }),
        "utf8",
    )

    // `null` means "the directory exists but holds no readable package.json"
    // — a half-extracted install, which must count as not installed.
    for (const [name, version] of Object.entries(files.installed ?? {})) {
        const dir = join(root, "node_modules", ...name.split("/"))
        await mkdir(dir, { recursive: true })
        if (version !== null) {
            await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8")
        }
    }

    return {
        root,
        manifest: Manifest({ root }),
        tree: Tree({ root }),
        async declared() {
            return JSON.parse(await Bun.file(join(root, "package.json")).text()).dependencies ?? {}
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
    }
}

const NOTHING_OWNED = () => false

describe("reconcile", () => {
    test("an owned dependency that is no longer declared is pruned", async () => {
        // Switching cognets left the previous brain in package.json forever,
        // because only `file:` modules were ever pruned.
        const p = await project({
            dependencies: { "@axon/zero": "^0.1.6", "@t/vehicle": "^0.1.0" },
            installed: { "@axon/zero": "0.1.6", "@t/vehicle": "0.1.0" },
        })
        try {
            const result = await reconcile({
                manifest: p.manifest,
                tree: p.tree,
                managed: { "@t/vehicle": "^0.1.0" },
                owned: name => name === "@axon/zero" || name === "@t/vehicle",
            })

            expect(result.pruned).toEqual(["@axon/zero"])
            expect(await p.declared()).toEqual({ "@t/vehicle": "^0.1.0" })
        } finally {
            await p.cleanup()
        }
    })

    test("a dependency Axon does not own is never pruned", async () => {
        // The safety property. A wrong guess here deletes something the user
        // added by hand, which is far worse than leaving a stale entry.
        const p = await project({
            dependencies: { "h3": "^1.13.0", "@t/vehicle": "^0.1.0" },
            installed: { "h3": "1.15.11", "@t/vehicle": "0.1.0" },
        })
        try {
            const result = await reconcile({
                manifest: p.manifest,
                tree: p.tree,
                managed: { "@t/vehicle": "^0.1.0" },
                owned: name => name === "@t/vehicle",
            })

            expect(result.pruned).toEqual([])
            expect(await p.declared()).toHaveProperty("h3")
        } finally {
            await p.cleanup()
        }
    })

    test("dryRun reports drift without touching the manifest", async () => {
        // What --frozen depends on: a check that repairs what it finds can
        // never fail, so it would assert nothing.
        const p = await project({
            dependencies: { "@axon/zero": "^0.1.6" },
            installed: { "@axon/zero": "0.1.6" },
        })
        try {
            const result = await reconcile({
                manifest: p.manifest,
                tree: p.tree,
                managed: {},
                owned: () => true,
                dryRun: true,
            })

            expect(result.pruned).toEqual(["@axon/zero"])
            expect(result.changed).toBe(true)
            // ...and the file is untouched.
            expect(await p.declared()).toEqual({ "@axon/zero": "^0.1.6" })
        } finally {
            await p.cleanup()
        }
    })

})
