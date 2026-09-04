import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Config } from "@arcforge/platform/build/blueprint"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("Config()", () => {
    it("resolves the real config a scaffolded agent produces", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            // Agent children may prepare the same project concurrently. Each
            // import must capture its own defineAgent() call.
            const [config, concurrent] = await Promise.all([
                Config(project.root),
                Config(project.root),
            ])

            // What this asserts is OBJECT IDENTITY, not any particular field.
            //
            // Two fields have now been probed here and then removed from the
            // scaffold — `description` (moved to package.json) and `engine`
            // (deprecated in favour of `providers:`/`model:`) — because a
            // scaffold that declares nothing is the correct scaffold: a user's
            // providers live on their profile and the agent inherits them.
            //
            // So probe the invariant itself. Each concurrent import must
            // capture its OWN defineAgent() call rather than share a cached
            // module, which is exactly "two distinct objects". That survives
            // the scaffold declaring anything, or nothing at all.
            expect(config.value).toBeDefined()
            expect(concurrent.value).toBeDefined()
            expect(concurrent.value).not.toBe(config.value)
            expect(config.modules).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("throws CONFIG_NOT_FOUND when axon.config.ts doesn't exist", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-empty-"))

        try {
            await expect(Config(dir)).rejects.toThrow(/Config Not Found/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("throws CONFIG_LOAD_FAILED when the config throws at import time", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-broken-"))

        try {
            await Bun.write(join(dir, "axon.config.ts"), "throw new Error('boom')\n")

            await expect(Config(dir)).rejects.toThrow(/axon\.config\.ts/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("throws CONFIG_INVALID when the config never calls defineAgent()", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-noagent-"))

        try {
            await Bun.write(join(dir, "axon.config.ts"), "export default { description: 'not a real agent config' }\n")

            await expect(Config(dir)).rejects.toThrow(/did not call defineAgent/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("exposes declared modules under .modules, unnormalised", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-modules-"))

        try {
            await Bun.write(
                join(dir, "axon.config.ts"),
                `export default defineAgent({ modules: ["@axon/telegram", "@axon/github"] })\n`,
            )

            const config = await Config(dir)

            expect(config.modules).toEqual(["@axon/telegram", "@axon/github"])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
