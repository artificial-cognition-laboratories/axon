import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

/**
 * `axon cognet init` inside an agent creates an INLINE cognet, and the step
 * after the scaffolder has to know that.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * An inline cognet is part of the agent: it lands at <agent>/cognet/, gets no
 * package.json (a second publishable package in one project), and
 * `detectKind()` refuses to claim the directory — all deliberate, all
 * documented. `create()` then did `open(scaffolded)` and got
 * PROJECT_NOT_FOUND against a directory it had written one line earlier, after
 * already printing "Scaffolding ✓".
 *
 * Nothing about the scaffolder was wrong. The failure was a pipeline stage
 * carrying an assumption ("what I scaffolded is a project") that the stage
 * before it had deliberately broken.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * Both halves, because fixing one by breaking the other is the easy mistake:
 * an inline cognet must stay part of its agent, and a standalone one must stay
 * a package of its own.
 */

function disposableName(prefix: string): string {
    return `@${TEST_USER.username}/test-${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

describe("cognet init, inline and standalone", () => {
    it("inside an agent: creates <agent>/cognet/ and prepares the AGENT", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-agent-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })

            // The scaffolder decides inline by the cwd holding an axon.config.ts,
            // so the cognet is created from inside the agent's own root.
            const steps: Array<{ step: string; root?: string; name?: string }> = []
            const returned = await platform.projects.create("cognet", {
                name: "inline-brain",
                dir: agent.root,
                onProgress: step => steps.push(step as never),
            })

            const inlineRoot = join(agent.root, "cognet")
            expect(existsSync(join(inlineRoot, "cognet.config.ts"))).toBe(true)

            // Part of the agent, not a package: a package.json here would
            // declare a second publishable artifact inside one project.
            expect(existsSync(join(inlineRoot, "package.json"))).toBe(false)

            // The project that owns it is the AGENT — that is what gets
            // prepared, because an inline cognet compiles from the agent's
            // node_modules into the agent's frame.
            expect(returned.root).toBe(agent.root)
            expect(returned.kind).toBe("agent")

            // …but what was CREATED is reported as the cognet. Reporting the
            // agent here would answer a request for a cognet by naming the
            // agent.
            const created = steps.find(s => s.step === "created")
            expect(created?.root).toBe(inlineRoot)
            expect(created?.name).toBe("inline-brain")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("outside an agent: creates a standalone, publishable cognet package", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-cognet-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const name = disposableName("cognet")
            const project = await platform.projects.create("cognet", { name, dir })

            // Its own project, its own manifest — the half that must not
            // regress while making the inline path work.
            expect(project.kind).toBe("cognet")
            expect(existsSync(join(project.root, "package.json"))).toBe(true)
            expect(existsSync(join(project.root, "cognet.config.ts"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    /**
     * The scaffolder decides inline from the cwd it is handed, so a stray
     * `axon.config.ts` beside the target is the whole trigger. Pinned because
     * the two branches produce very different artifacts and the choice is made
     * on one `existsSync`.
     */
    it("a bare directory with an axon.config.ts is treated as the owning agent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-agent-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: disposableName("agent"), dir })
            await writeFile(join(agent.root, "MARKER"), "")

            await platform.projects.create("cognet", { name: "brain", dir: agent.root })

            expect(existsSync(join(agent.root, "cognet", "cognet.config.ts"))).toBe(true)
            expect(existsSync(join(agent.root, "brain"))).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)
})
