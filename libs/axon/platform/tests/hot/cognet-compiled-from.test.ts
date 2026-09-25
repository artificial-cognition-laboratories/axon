import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cognet } from "@arcforge/platform/build/blueprint"

/**
 * `compiledFrom` — where the brain this agent is running came from.
 *
 * The dev watcher asks for it, and is built from a DIFFERENT Cognet()
 * instance than the one prepare compiled with. When the answer came from
 * in-memory state it was therefore always unset there, and the fallback
 * resolved DEFAULT_COGNET — so every agent running anything other than
 * @axon/zero failed at boot with "@axon/zero is declared but not present in
 * node_modules", naming a cognet the project had never mentioned.
 *
 * The answer has to survive the process that produced it, so it lives in the
 * manifest the compile writes.
 */

async function agentRoot(manifest?: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "axon-compiled-from-"))
    if (manifest) {
        await mkdir(join(root, ".agent", "cognet"), { recursive: true })
        await writeFile(
            join(root, ".agent", "cognet", "manifest.json"),
            JSON.stringify(manifest),
            "utf8",
        )
    }
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("Cognet.compiledFrom", () => {
    test("reports the source the last compile recorded", async () => {
        const brain = await mkdtemp(join(tmpdir(), "axon-brain-"))
        const a = await agentRoot({ name: "vehicle", sourceDir: brain })
        try {
            expect(Cognet({ root: a.root }).compiledFrom).toBe(brain)
        } finally {
            await a.cleanup()
            await rm(brain, { recursive: true, force: true })
        }
    })

    test("is null when nothing has been compiled — never the registry default", async () => {
        // The regression. Guessing here is what produced a boot failure
        // naming @axon/zero for an agent that runs a different brain.
        const a = await agentRoot()
        try {
            expect(Cognet({ root: a.root }).compiledFrom).toBeNull()
        } finally {
            await a.cleanup()
        }
    })

    test("is null when the recorded source no longer exists on disk", async () => {
        // A manifest can outlive its source — a cognet uninstalled, or a
        // checkout moved. Watching a path that is gone is not better than
        // not watching.
        const a = await agentRoot({ name: "vehicle", sourceDir: "/nonexistent/brain" })
        try {
            expect(Cognet({ root: a.root }).compiledFrom).toBeNull()
        } finally {
            await a.cleanup()
        }
    })

    test("is null for a manifest written before sourceDir was recorded", async () => {
        // Forward compatibility: an agent compiled by an older CLI has a
        // manifest with no sourceDir, and must degrade to "unknown" rather
        // than to a wrong answer.
        const a = await agentRoot({ name: "vehicle", hash: "abc" })
        try {
            expect(Cognet({ root: a.root }).compiledFrom).toBeNull()
        } finally {
            await a.cleanup()
        }
    })
})
