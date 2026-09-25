import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * An agent runs in ITS OWN root, never the caller's directory.
 *
 * Agent code must behave the same wherever it was invoked from, and
 * identically to how it runs DEPLOYED — where there is no invocation
 * directory at all. Without this a script's `fs.read("axon.config.ts")`
 * depended on where the user happened to be standing: it worked from inside
 * the agent and failed one directory up, which is the same script giving two
 * answers.
 *
 * The gap was specific and easy to miss. `Confinement()` set the cwd for the
 * bwrap box — so a BOXED agent was always correct — while `isolation: "none"`
 * never builds one and fell through to `Bun.spawn`'s default of inheriting
 * the parent. The bug therefore existed only on the unboxed tier, which is
 * the tier every local run uses.
 *
 * Asserted structurally because the property is about the SPAWN, and the
 * behavioural version needs a real agent, a real profile and a process. This
 * is the cheap guard; the end-to-end truth is one `-s` run away.
 */

const CONFINED_SRC = readFileSync(
    join(import.meta.dir, "../../src/confined.ts"),
    "utf-8",
)

describe("agent cwd — the agent's own root, on every tier", () => {
    it("spawns the agent process in the project root", () => {
        // The literal spawn options. `Bun.spawn` with no cwd inherits the
        // caller's, which is the whole defect.
        const spawn = CONFINED_SRC.slice(CONFINED_SRC.indexOf("Bun.spawn(command"))
        expect(spawn).toContain("cwd: opts.blueprint.paths.root")
    })

    it("sets it OUTSIDE the confinement branch, so an unboxed agent gets it too", () => {
        // The confinement block configures the box; an `isolation: "none"`
        // agent never enters it. If the only `cwd:` in this file sits inside
        // that branch, the unboxed tier has silently regressed.
        const spawnIndex = CONFINED_SRC.indexOf("Bun.spawn(command")
        const confinementIndex = CONFINED_SRC.indexOf("await Confinement({")

        expect(confinementIndex).toBeGreaterThan(-1)
        expect(spawnIndex).toBeGreaterThan(confinementIndex)
    })
})
