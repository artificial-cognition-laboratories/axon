import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"

/**
 * Whether the config declares a module BY REGISTRY NAME — the question
 * `uninstall` asks before it touches anything.
 *
 * The distinction is not cosmetic. A registry module is a string in
 * `modules: [...]`, which the config edits can remove. A SOURCE module is an
 * import binding, which they cannot — the import statement is the author's
 * code. Getting this wrong is what let uninstall strip a dependency from
 * package.json while the config went on importing it, report "uninstalled",
 * and leave the agent still loading the module.
 *
 * Both kinds have a package name, so the name alone can never answer this.
 */

async function withConfig<T>(source: string, run: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-declares-test-"))
    try {
        await writeFile(join(root, "axon.config.ts"), source)
        return await run(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const REGISTRY = `
export default defineAgent({
    modules: [
        "@axon/fs",
        "@axon/telegram",
    ],
})
`

const SOURCE = `
import Mod from "../../../registry/modules/telegram/module.config"

export default defineAgent({
    modules: [
        "@axon/fs",
        Mod
    ],
})
`

describe("config.declaresName: registry name vs source import", () => {
    test("a module listed by name is declared", async () => {
        await withConfig(REGISTRY, async root => {
            expect(await Manifest({ root }).config.declaresName("@axon/telegram")).toBe(true)
        })
    })

    test("a module bound by import is NOT declared by name", async () => {
        // The bug this gate exists for: the module IS installed and loaded,
        // but its declaration is an import the config edits cannot rewrite.
        // Answering true here would let uninstall proceed and half-remove it.
        await withConfig(SOURCE, async root => {
            expect(await Manifest({ root }).config.declaresName("@axon/telegram")).toBe(false)
        })
    })

    test("an unrelated module is not declared", async () => {
        await withConfig(REGISTRY, async root => {
            expect(await Manifest({ root }).config.declaresName("@axon/github")).toBe(false)
        })
    })

    test("a missing config declares nothing, rather than throwing", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-declares-test-"))
        try {
            expect(await Manifest({ root }).config.declaresName("@axon/fs")).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
