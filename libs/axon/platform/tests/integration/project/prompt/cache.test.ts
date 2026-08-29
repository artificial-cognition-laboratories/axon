import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AxonBlueprint } from "@arcforge/types"
import { Prompt } from "../../../../../core/src/runtime/source/render"
import { Prompts } from "../../../../src/services/prompts"
import { scanPromptPackage } from "../../../../src/build/blueprint/scan/promptPackages"

/**
 * Prompts are CACHED, not installed.
 *
 * The behavior these pin is the whole point of the design: a published prompt
 * renders against the focused agent while living outside it — no node_modules
 * entry, no package.json dependency, no reload. Everything below asserts
 * through the public seams (Prompts().entry → axon.prompts.renderEntry), never
 * against internals.
 */

const NAME = "@scope/pack"

/** A fake published prompt package, already extracted into a cache directory. */
async function stageCache(files: Record<string, string>): Promise<{ root: string; cacheRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-prompt-cache-"))
    const cacheRoot = join(root, "cache", "prompts", "@scope", "pack", "0.1.0")

    for (const [relative, contents] of Object.entries(files)) {
        const target = join(cacheRoot, relative)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, contents)
    }
    await writeFile(
        join(cacheRoot, "package.json"),
        JSON.stringify({ name: NAME, version: "0.1.0", type: "module" }, null, 2),
    )

    return { root, cacheRoot }
}

/**
 * A cache stub standing in for the network half. `ensure` is the only thing
 * Prompts() asks of it, and what it returns — name, version, an extracted
 * directory — is exactly what a real fetch produces.
 */
function cacheStub(name: string, root: string) {
    let fetches = 0
    return {
        get fetches() { return fetches },
        async ensure(_ref: string) {
            fetches++
            return { name, version: "0.1.0", root }
        },
        async cached() {
            return [{ name, version: "0.1.0", root }]
        },
    }
}

describe("published prompts render from the cache, not the agent", () => {
    it("renders a cached prompt against an agent that never declared it", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><h1>Cached</h1></template>\n",
        })

        try {
            const prompts = Prompts({ cache: cacheStub(NAME, cacheRoot) })
            const entry = await prompts.entry(NAME)

            // The agent's own blueprint is EMPTY — it declares no prompts at
            // all. renderEntry is what makes this possible; render(name) would
            // correctly throw PROMPT_NOT_FOUND.
            const blueprint = { prompts: [], env: {} } as unknown as AxonBlueprint
            const out = await Prompt({ blueprint }).renderEntry(entry)

            expect(out).toContain("Cached")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("renders in the agent's scope — the agent's env, not the host's", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><p>{{ process.env.AGENT_NAME }}</p></template>\n",
        })

        try {
            const entry = await Prompts({ cache: cacheStub(NAME, cacheRoot) }).entry(NAME)
            const blueprint = { prompts: [], env: { AGENT_NAME: "barry" } } as unknown as AxonBlueprint

            expect(await Prompt({ blueprint }).renderEntry(entry)).toContain("barry")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("renders a static .md prompt verbatim", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.md": "# Review checklist\n\nrun the tests\n",
        })

        try {
            const entry = await Prompts({ cache: cacheStub(NAME, cacheRoot) }).entry(NAME)
            const blueprint = { prompts: [], env: {} } as unknown as AxonBlueprint

            expect(await Prompt({ blueprint }).renderEntry(entry)).toContain("run the tests")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("inlines composed components, same as a declared prompt", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><h1>Outer</h1><Shared /></template>\n",
            "components/shared.vue": "<template><p>fragment body</p></template>\n",
        })

        try {
            const entry = await Prompts({ cache: cacheStub(NAME, cacheRoot) }).entry(NAME)
            const blueprint = { prompts: [], env: {} } as unknown as AxonBlueprint
            const out = await Prompt({ blueprint }).renderEntry(entry)

            expect(out).toContain("fragment body")
            expect(out).not.toContain("<Shared")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("leaves the agent untouched — no dependency, no node_modules entry", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><p>content</p></template>\n",
        })
        const agentRoot = await mkdtemp(join(tmpdir(), "axon-test-agent-"))

        try {
            const manifest = { name: "barry", version: "0.1.0", dependencies: {} }
            await writeFile(join(agentRoot, "package.json"), JSON.stringify(manifest, null, 2))
            await writeFile(join(agentRoot, "axon.config.ts"), "export default defineAgent({})\n")

            const entry = await Prompts({ cache: cacheStub(NAME, cacheRoot) }).entry(NAME)
            const blueprint = { prompts: [], env: {} } as unknown as AxonBlueprint
            await Prompt({ blueprint }).renderEntry(entry)

            // The three things installing used to change, all unchanged.
            expect(JSON.parse(await readFile(join(agentRoot, "package.json"), "utf-8"))).toEqual(manifest)
            expect(await readFile(join(agentRoot, "axon.config.ts"), "utf-8")).toBe("export default defineAgent({})\n")
            expect(existsSync(join(agentRoot, "node_modules"))).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
            await rm(agentRoot, { recursive: true, force: true })
        }
    })

    it("fetches once, then serves the same prompt from disk", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><p>content</p></template>\n",
        })

        try {
            const cache = cacheStub(NAME, cacheRoot)
            const prompts = Prompts({ cache })

            await prompts.entry(NAME)
            await prompts.entry(NAME)

            // ensure() is called each time — it is the cache's own job to skip
            // the download when the version is already on disk. What matters
            // here is that resolution never reaches for the agent.
            expect(cache.fetches).toBe(2)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("names every prompt in a multi-prompt package rather than guessing", async () => {
        const { root, cacheRoot } = await stageCache({
            "review.vue": "<template><p>review</p></template>\n",
            "handoff.vue": "<template><p>handoff</p></template>\n",
        })

        try {
            const prompts = Prompts({ cache: cacheStub(NAME, cacheRoot) })

            expect((await prompts.entries(NAME)).map(entry => entry.name).sort())
                .toEqual([`${NAME}:handoff`, `${NAME}:review`])

            // The bare name is ambiguous here — picking one silently would be a guess.
            await expect(prompts.entry(NAME)).rejects.toMatchObject({ code: "AX-PROMPT-001" })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it("scans a cached package identically to an installed one", async () => {
        const { root, cacheRoot } = await stageCache({
            "pack.vue": "<template><p>content</p></template>\n",
        })

        try {
            const scanned = await scanPromptPackage(cacheRoot, NAME)

            // The bare-name shorthand a single-prompt package gets — the same
            // rule that applies under node_modules.
            expect(scanned.entries.map(entry => entry.name).sort()).toEqual([NAME, `${NAME}:pack`])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
