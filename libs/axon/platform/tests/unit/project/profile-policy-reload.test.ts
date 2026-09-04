import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readPolicy } from "@arcforge/platform/build/extensions"

/**
 * The ceiling is re-read from DISK, never cached.
 *
 * `readPolicy` is called per blueprint load precisely so a reload picks up an
 * edited profile — the comment on `profileCeiling()` says as much. Nothing
 * asserted it, and a cache introduced here would be invisible: every surface
 * would render the policy on disk while agents kept enforcing the one read at
 * boot, which is the failure mode where a policy system is worse than useless.
 *
 * This is the disk half of the guarantee. The runtime half — that a reload
 * re-applies whatever this returns — is
 * `core/tests/integration/kernel/reload/policy.test.ts`. Neither is sufficient
 * alone: a correct re-read handed to nobody, and a correct re-apply of a stale
 * value, both produce exactly the bug that was reported.
 */

async function withProfile<T>(run: (root: string, write: (source: string) => Promise<void>) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-policy-reload-"))
    const write = (source: string) => writeFile(join(root, "profile.config.ts"), source)
    try {
        return await run(root, write)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const allowing = `
export default defineProfile({
    policy: { shell: { allow: ["*"] } },
})
`

const tightened = `
export default defineProfile({
    policy: { shell: {} },
})
`

describe("the profile ceiling across an edit", () => {
    test("a tightened profile is visible on the very next read", async () => {
        // Exactly the reported edit: `allow: ["*"]` commented out mid-session.
        await withProfile(async (root, write) => {
            await write(allowing)
            const before = await readPolicy(root)
            expect((before as { shell?: { allow?: string[] } }).shell?.allow).toEqual(["*"])

            await write(tightened)
            const after = await readPolicy(root)
            expect((after as { shell?: { allow?: string[] } }).shell?.allow).toBeUndefined()
        })
    })

    test("a loosened profile is visible on the very next read", async () => {
        // The other direction matters too: a ceiling that cannot be relaxed
        // leaves an agent refusing work the user has already permitted.
        await withProfile(async (root, write) => {
            await write(tightened)
            expect((await readPolicy(root) as { shell?: { allow?: string[] } }).shell?.allow).toBeUndefined()

            await write(allowing)
            expect((await readPolicy(root) as { shell?: { allow?: string[] } }).shell?.allow).toEqual(["*"])
        })
    })

    test("a profile whose policy block is deleted entirely declares no ceiling", async () => {
        // Deleting the block must mean "no opinion", not "keep what you had" —
        // a stale ceiling surviving its own deletion is the same bug wearing a
        // different hat.
        await withProfile(async (root, write) => {
            await write(allowing)
            expect(Object.keys(await readPolicy(root)).length).toBeGreaterThan(0)

            await write(`export default defineProfile({ settings: { theme: "arcnight" } })\n`)
            expect(await readPolicy(root)).toEqual({})
        })
    })
})
