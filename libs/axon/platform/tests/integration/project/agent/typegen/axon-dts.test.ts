import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

describe("agent project: typegen() axon.d.ts", () => {
    it("writes a real .agent/types/axon.d.ts declaring the runtime globals", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "axon.d.ts"), "utf-8")

            expect(dts).toContain("const axon: AxonHandle")
            expect(dts).toContain("const ui: UiHandle")
            expect(dts).toContain("do not edit")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("declares the engine adapters (Ollama, Codex, OpenRouter, Mock)", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const dts = await readFile(join(project.root, ".agent", "types", "axon.d.ts"), "utf-8")

            expect(dts).toContain("const Ollama: typeof import(\"@arcforge/engines\").Ollama")
            expect(dts).toContain("const Codex: typeof import(\"@arcforge/engines\").Codex")
            expect(dts).toContain("const Mock: typeof import(\"@arcforge/engines\").Mock")
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("re-running typegen overwrites axon.d.ts rather than appending to it", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })
            const { blueprint } = await Blueprint({ root: project.root }).load()

            await project.typegen(blueprint)
            const first = await readFile(join(project.root, ".agent", "types", "axon.d.ts"), "utf-8")

            await project.typegen(blueprint)
            const second = await readFile(join(project.root, ".agent", "types", "axon.d.ts"), "utf-8")

            expect(second).toBe(first)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
