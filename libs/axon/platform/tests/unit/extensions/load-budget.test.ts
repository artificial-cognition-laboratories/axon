import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DisposerSink, loadSource } from "@arcforge/platform/build/extensions/load"

/**
 * A file that never finishes must not cost the user their terminal.
 *
 * Per-file containment already covers a file that THROWS. It did not cover one
 * that never returns — an await on something that never resolves (a fetch with
 * no timeout, a lock, a read on a stream nobody writes to). That stalled boot
 * indefinitely with no diagnostic: a black terminal and no way to learn why.
 *
 * What is asserted here is the honest guarantee: the loader REPORTS and moves
 * on. It does not claim to have stopped the file — JavaScript cannot interrupt
 * code mid-execution, and the error says so.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function source(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-budget-"))
    roots.push(root)
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body)
    return root
}

const load = (root: string) =>
    loadSource({ root, label: "profile", sink: DisposerSink(), mainError: "PROFILE_MAIN_FAILED" })

describe("load budget", () => {
    test("a file that never resolves is reported, and the load continues", async () => {
        const root = await source({
            "main.ts": `await new Promise(() => {})\n`,
        })

        const result = await load(root)
        const failure = result.files[0]!.error as { code?: string } | null

        expect(failure).not.toBeNull()
        expect(failure?.code).toBe("AX-EXT-034")
    }, 30_000)

    test("the error names the file, so the user knows where to look", async () => {
        const root = await source({ "main.ts": `await new Promise(() => {})\n` })

        const result = await load(root)
        const message = String((result.files[0]!.error as { message?: unknown } | null)?.message ?? "")

        expect(message).toContain(join(root, "main.ts"))
        expect(message).not.toContain(".axon-reload-")
    }, 30_000)

    test("a fast file is untouched by the budget", async () => {
        // The budget must be invisible in the ordinary case.
        const root = await source({ "main.ts": `export const ok = true\n` })

        const result = await load(root)

        expect(result.files[0]!.error).toBeNull()
    })
})
