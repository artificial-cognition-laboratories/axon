import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { materializeTool, toolCacheDir } from "../src/process/materialize"

/**
 * Where bundled tool source is written before it is imported.
 *
 * This is load-bearing in a way that is easy to miss. The agent process is
 * spawned with an environment BUILT FROM NOTHING (link/confined.ts `floorEnv`),
 * and `TMPDIR` is not on the pass-through list — so `os.tmpdir()` resolves one
 * directory on the host and a different one inside the agent. On Linux both
 * usually land on `/tmp` and it works by coincidence; on macOS the host has
 * `TMPDIR=/var/folders/…` and the agent falls back to `/tmp` (a symlink to
 * `/private/tmp`), so every import failed and the agent could not boot at all.
 *
 * These pin the property that prevents it: the destination is derived from a
 * path the CALLER supplies, and this module never asks the process where to
 * write. A regression would be reintroducing any ambient lookup here.
 */

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "materialize-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("tool materialization", () => {
    it("writes source to the directory it was given", async () => {
        const scratch = join(dir, "cache", "tools")

        const file = await materializeTool(scratch, "export const x = 1\n")

        expect(file.startsWith(scratch)).toBe(true)
        expect(await readFile(file, "utf-8")).toBe("export const x = 1\n")
    })

    it("creates the directory on demand", async () => {
        // An agent that never loads a bundled tool never makes the directory,
        // so it cannot be a precondition the caller has to satisfy first.
        const scratch = join(dir, "deep", "not", "yet", "there")

        await expect(materializeTool(scratch, "export const y = 2\n")).resolves.toBeDefined()
    })

    it("gives identical source one file, not one per call", async () => {
        // Content-hashed: a reload, or two agents sharing a module, reuse the
        // same file rather than leaking one per load.
        const scratch = join(dir, "tools")

        const first = await materializeTool(scratch, "export const same = 1\n")
        const second = await materializeTool(scratch, "export const same = 1\n")

        expect(second).toBe(first)
    })

    it("gives different source different files", async () => {
        const scratch = join(dir, "tools")

        const first = await materializeTool(scratch, "export const a = 1\n")
        const second = await materializeTool(scratch, "export const b = 2\n")

        expect(second).not.toBe(first)
    })

    it("does not consult the environment for its destination", async () => {
        // THE regression guard. With TMPDIR pointing somewhere else entirely,
        // the file must still land under the caller's directory — that
        // independence is the whole fix.
        const scratch = join(dir, "tools")
        const previous = process.env.TMPDIR
        process.env.TMPDIR = join(dir, "decoy")

        try {
            const file = await materializeTool(scratch, "export const z = 3\n")
            expect(file.startsWith(scratch)).toBe(true)
            expect(file).not.toContain("decoy")
        } finally {
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
        }
    })

    it("resolves the tool room inside the frame's cache", async () => {
        // `.agent/cache/` is the regenerable, disposable room — which is what
        // materialized source is. `.agent/data/` is user history and is
        // committed by convention, so scratch must never land there.
        expect(toolCacheDir("/agent/.agent/cache")).toBe("/agent/.agent/cache/tools")
    })
})
