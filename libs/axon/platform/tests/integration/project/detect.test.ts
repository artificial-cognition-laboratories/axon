import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("project detection: discriminating agent vs module vs neither", () => {
    it("open() throws when the directory has neither axon.config.ts nor module.config.ts", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-empty-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await expect(platform.projects.open(dir)).rejects.toThrow(/Project Not Found/)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    /**
     * Scaffolds TWO real projects (an agent, then a module inside it), which
     * is genuine fs + install work. Bun's 5s default is enough alone — 564ms
     * measured — but not under `bun test --parallel=4`, where it timed out
     * intermittently while three other suites competed for the same disk.
     *
     * The generous ceiling is not hiding slowness: this test either scaffolds
     * two projects or it does not, and a timeout here should mean "broken",
     * never "the machine was busy".
     */
    it("an agent that contains a nested module still opens as kind 'agent' at its own root", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const agentName = disposableName()
        const moduleName = `test-module-${crypto.randomUUID().slice(0, 8)}`

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const agent = await platform.projects.create("agent", { name: agentName, dir })
            await platform.projects.create("module", { name: moduleName, dir: agent.root })

            const reopened = await platform.projects.open(agent.root)
            expect(reopened.kind).toBe("agent")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 30_000)
})
