import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config } from "../../../../src/build/project/manifest/config"
import { describe, it, expect } from "bun:test"

/**
 * Declaring and undeclaring a prompt package in axon.config.ts.
 *
 * A prompt installs exactly like a module — into node_modules, as an ordinary
 * dependency — and differs only in which array declares it. These pin that
 * split: the installer routes by kind on the way IN, while removal is
 * line-oriented and kind-agnostic, so the two must agree without either
 * knowing about the other.
 */

const CONFIG = `export default defineAgent({
    prompts: [
        "@axon/tdd",
        "@axon/research",
    ],
    modules: [
        "@axon/tavily",
    ],
})
`

async function withConfig(
    source: string,
    fn: (ctx: { config: ReturnType<typeof Config>; read: () => Promise<string> }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-config-"))
    try {
        await writeFile(join(root, "axon.config.ts"), source)
        await fn({
            config: Config({ root }),
            read: () => readFile(join(root, "axon.config.ts"), "utf-8"),
        })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("prompt package: declaration", () => {
    it("adds a prompt to prompts, never to modules", async () => {
        await withConfig(CONFIG, async ({ config, read }) => {
            await config.add("@axon/commit", "prompts")

            expect(await config.declared("prompts")).toContain("@axon/commit")
            expect(await config.declared("modules")).not.toContain("@axon/commit")
            // The module array is untouched by a prompt install.
            expect(await config.declared("modules")).toEqual(new Set(["@axon/tavily"]))
            expect(await read()).toContain('"@axon/commit"')
        })
    })

    it("creates the prompts array when an agent has never installed one", async () => {
        await withConfig(
            'export default defineAgent({\n    modules: [\n        "@axon/tavily",\n    ],\n})\n',
            async ({ config }) => {
                await config.add("@axon/tdd", "prompts")

                expect(await config.declared("prompts")).toContain("@axon/tdd")
                expect(await config.declared("modules")).toContain("@axon/tavily")
            },
        )
    })

    it("does not re-declare a prompt that is already there", async () => {
        await withConfig(CONFIG, async ({ config }) => {
            const added = await config.add("@axon/tdd", "prompts")

            expect(added).toBe(false)
            expect([...(await config.declared("prompts"))].filter(n => n === "@axon/tdd")).toHaveLength(1)
        })
    })

    it("removes a prompt and leaves its siblings alone", async () => {
        await withConfig(CONFIG, async ({ config }) => {
            await config.remove("@axon/tdd")

            const prompts = await config.declared("prompts")
            expect(prompts).not.toContain("@axon/tdd")
            expect(prompts).toContain("@axon/research")
            expect(await config.declared("modules")).toContain("@axon/tavily")
        })
    })

    it("removes the last prompt without breaking the config", async () => {
        await withConfig(
            'export default defineAgent({\n    prompts: [\n        "@axon/tdd",\n    ],\n})\n',
            async ({ config, read }) => {
                await config.remove("@axon/tdd")

                expect(await config.declared("prompts")).toEqual(new Set())
                // Still parseable — an emptied array is fine, a mangled one is not.
                const source = await read()
                expect(source).toContain("defineAgent")
                expect(source).toContain("prompts:")
            },
        )
    })

    it("reports a name that was never declared", async () => {
        await withConfig(CONFIG, async ({ config }) => {
            expect(await config.remove("@axon/never-installed")).toBe(false)
        })
    })

    it("removes a module the same way, without knowing the kind", async () => {
        await withConfig(CONFIG, async ({ config }) => {
            // remove() is line-oriented: one verb serves both arrays, which is
            // why uninstall never has to resolve the artifact's kind first.
            await config.remove("@axon/tavily")

            expect(await config.declared("modules")).toEqual(new Set())
            expect(await config.declared("prompts")).toContain("@axon/tdd")
        })
    })
})
