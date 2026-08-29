import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * The managed base workspace is deleted. Existing installs still have its
 * directory and manifest on disk, and nothing reads either — this removes them
 * without touching anything the user owns.
 */
describe("store.pruneLegacyBase", () => {
    it("removes the legacy base workspace and its manifest", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const profile = join(storeDir, "profiles", "someone@example.com")
            await mkdir(join(profile, "base"), { recursive: true })
            await writeFile(join(profile, "base", "axon.config.ts"), "export default {}\n")
            await writeFile(join(profile, "base.json"), "{}\n")

            Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir }).store.pruneLegacyBase()

            expect(existsSync(join(profile, "base"))).toBe(false)
            expect(existsSync(join(profile, "base.json"))).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("leaves the user's own agents alone", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const profile = join(storeDir, "profiles", "someone@example.com")
            await mkdir(join(profile, "base"), { recursive: true })
            await mkdir(join(profile, "agents", "dave"), { recursive: true })
            await writeFile(join(profile, "agents", "dave", "axon.config.ts"), "export default {}\n")

            Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir }).store.pruneLegacyBase()

            expect(existsSync(join(profile, "base"))).toBe(false)
            expect(existsSync(join(profile, "agents", "dave", "axon.config.ts"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("is a no-op for a profile that never used the old flow", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const profile = join(storeDir, "profiles", "someone@example.com")
            await mkdir(join(profile, "agents", "dave"), { recursive: true })

            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.pruneLegacyBase()
            platform.store.pruneLegacyBase()

            expect(existsSync(join(profile, "agents", "dave"))).toBe(true)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
