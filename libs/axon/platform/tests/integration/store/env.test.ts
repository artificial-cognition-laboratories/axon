import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

describe("store.env", () => {
    it("defaults to 'cloud' when nothing has been set", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(platform.store.env.get()).toBe("cloud")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("set('local') persists and is read back by get()", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.env.set("local")

            expect(platform.store.env.get()).toBe("local")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("set('cloud') round-trips explicitly, not just by omission", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            platform.store.env.set("local")
            platform.store.env.set("cloud")

            expect(platform.store.env.get()).toBe("cloud")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("persists across a fresh Platform({ version: TEST_VERSION }) instance pointed at the same store", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const first = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            first.store.env.set("local")

            const second = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(second.store.env.get()).toBe("local")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("treats unrecognized or malformed content as 'cloud' rather than throwing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await Bun.write(join(storeDir, "env"), "not-a-real-target\n")

            expect(platform.store.env.get()).toBe("cloud")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("tolerates surrounding whitespace in the persisted value", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            await Bun.write(join(storeDir, "env"), "  local  \n")

            expect(platform.store.env.get()).toBe("local")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
