import { mkdtemp, rm, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

describe("store.cache", () => {
    it("get() is null before anything has been cached", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ value: string }>("registry")

            expect(file.get()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("set() then get() round-trips a real typed value", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ agents: string[] }>("registry")

            file.set({ agents: ["one", "two"] })

            expect(file.get()).toEqual({ agents: ["one", "two"] })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("different cache names are fully isolated from one another", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const registry = platform.store.cache.file<{ tag: string }>("registry")
            const models = platform.store.cache.file<{ tag: string }>("models")

            registry.set({ tag: "registry-value" })
            models.set({ tag: "models-value" })

            expect(registry.get()).toEqual({ tag: "registry-value" })
            expect(models.get()).toEqual({ tag: "models-value" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("delete() removes the cached value — get() returns null again", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ value: string }>("registry")

            file.set({ value: "cached" })
            file.delete()

            expect(file.get()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("update() applies a read-modify-write against the missing-file initial value", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ count: number }>("registry")

            file.update({ count: 0 }, current => ({ count: current.count + 1 }))

            expect(file.get()).toEqual({ count: 1 })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("update() applies against the real existing value, not the initial default", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ count: number }>("registry")

            file.set({ count: 5 })
            file.update({ count: 0 }, current => ({ count: current.count + 1 }))

            expect(file.get()).toEqual({ count: 6 })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("writes are atomic — no leftover .tmp file, and the target is always complete, valid JSON", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const file = platform.store.cache.file<{ agents: string[] }>("registry")

            file.set({ agents: ["one", "two", "three"] })

            const cacheDir = join(storeDir, "cache")
            const entries = await readdir(cacheDir)
            expect(entries.some(name => name.endsWith(".tmp"))).toBe(false)

            const raw = await readFile(join(cacheDir, "registry.json"), "utf-8")
            expect(() => JSON.parse(raw)).not.toThrow()
            expect(JSON.parse(raw)).toEqual({ agents: ["one", "two", "three"] })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })

    it("persists across a fresh Platform({ version: TEST_VERSION }) instance pointed at the same store", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))

        try {
            const first = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            first.store.cache.file<{ value: string }>("registry").set({ value: "persisted" })

            const second = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            expect(second.store.cache.file<{ value: string }>("registry").get()).toEqual({ value: "persisted" })
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
