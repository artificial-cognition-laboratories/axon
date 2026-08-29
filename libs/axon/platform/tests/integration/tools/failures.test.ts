import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * A broken tool takes the scan down with it.
 *
 * There is no graceful degradation of a tool that will not compile. The agent's
 * scope is a contract between what the author wrote and what the model is told
 * it can call; a tool missing from that scope means the running agent is not
 * the agent the author asked for. That is an invalid state, and invalid states
 * crash.
 *
 * This was previously a warning pushed onto Scanned.warnings, and the scan
 * carried on with an empty tool map. Two things made that indefensible rather
 * than merely lenient: the warning was dropped entirely at runtime boot (only
 * the `prepare` and `dev` CLI paths ever printed one), and the empty result was
 * written to the declare cache against the source hash — so the degraded state
 * survived every subsequent reboot with no way to recover but editing the file.
 *
 * These tests run against a real scaffolded agent through Blueprint.load(),
 * the same path a boot takes, so they pin the behavior at the boundary a user
 * actually hits rather than at the function that happens to detect it.
 */

const dirs: string[] = []
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

/** A real scaffolded agent with the given files written into src/tools/. */
async function agentWithTools(files: Record<string, string>): Promise<string> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    dirs.push(storeDir, dir)

    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    const project = await platform.projects.create("agent", { name: disposableName(), dir })
    await mkdir(join(project.root, "src", "tools"), { recursive: true })
    for (const [name, source] of Object.entries(files)) {
        await writeFile(join(project.root, "src", "tools", name), source)
    }
    return project.root
}

describe("blueprint load: a tool that cannot be declared fails the load", () => {
    test("a syntactically broken tool fails the load", async () => {
        const root = await agentWithTools({ "broken.ts": "export function f( { return\n" })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 60_000)

    test("a tool importing an unresolvable module fails the load", async () => {
        const root = await agentWithTools({
            "broken.ts": "import { gone } from './nowhere'\nexport function f() { return gone }\n",
        })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 60_000)

    test("the failure names the offending tool file", async () => {
        // An agent's own src/tools and several installed modules all fail with
        // the same error code; without the filename the message cannot say
        // which tool to go and fix. This is the single most useful thing the
        // reported bug was missing.
        const root = await agentWithTools({
            "kanban.ts": "import { gone } from './nowhere'\nexport function f() { return gone }\n",
        })

        expect(Blueprint({ root }).load()).rejects.toThrow(/kanban/)
    }, 60_000)

    test("one broken tool fails the load even when other tools are fine", async () => {
        // No partial scope. An agent booted against the surviving tools is
        // quietly not the agent that was written.
        const root = await agentWithTools({
            "good.ts": "export function good() { return 1 }\n",
            "broken.ts": "import { gone } from './nowhere'\nexport function f() { return gone }\n",
        })

        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 60_000)
})

describe("blueprint load: a healthy agent still loads", () => {
    test("well-formed tools load and enter the blueprint", async () => {
        // The counterweight: everything above asserts a throw, so this pins
        // that the throw is specific to broken input and the happy path is
        // untouched.
        const root = await agentWithTools({
            "math.ts": "export function add(a: number, b: number) { return a + b }\n",
        })

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools.map(t => t.name)).toContain("math")
    }, 60_000)

    test("an agent with no tools at all loads cleanly", async () => {
        const root = await agentWithTools({})

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools).toEqual([])
    }, 60_000)

    test("a load that succeeds reports no tool warnings", async () => {
        const root = await agentWithTools({
            "math.ts": "export function add(a: number, b: number) { return a + b }\n",
        })

        const { warnings } = await Blueprint({ root }).load()

        expect(warnings.filter(w => w.domain === "tools")).toEqual([])
    }, 60_000)
})

describe("blueprint load: failure is not cached as success", () => {
    test("a failed load stays failed across repeated loads", async () => {
        // The stickiness property, at the boundary the user hit. A first load
        // that failed must not leave behind a cache entry that makes the second
        // load succeed-with-nothing. Reboot after reboot reported toolCount: 0
        // precisely because it did.
        const root = await agentWithTools({
            "broken.ts": "import { gone } from './nowhere'\nexport function f() { return gone }\n",
        })

        expect(Blueprint({ root }).load()).rejects.toThrow()
        expect(Blueprint({ root }).load()).rejects.toThrow()
    }, 60_000)

    test("fixing a broken tool makes the next load succeed", async () => {
        // Recovery must not require deleting a cache by hand.
        const root = await agentWithTools({
            "math.ts": "import { gone } from './nowhere'\nexport function f() { return gone }\n",
        })
        await Blueprint({ root }).load().catch(() => {})

        await writeFile(join(root, "src", "tools", "math.ts"), "export function add(a: number) { return a }\n")
        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools.map(t => t.name)).toContain("math")
    }, 60_000)
})
