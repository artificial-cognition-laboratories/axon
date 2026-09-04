import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { toScope, scopeToDts } from "@arcforge/core"
import { renderScope } from "@arcforge/air"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"

/**
 * A module's tools, from a directory on disk to the agent's callable scope.
 *
 * Everything under tests/unit/tools and tests/integration/tools exercises an
 * agent's OWN src/tools. A module's tools travel a longer path — scanned in the
 * module's root, re-tagged with its origin, merged against the agent's own
 * surface, then rendered for two audiences — and none of that had end-to-end
 * coverage.
 *
 * The convention every registry module follows is one tool file named after the
 * module, exporting one object of the same name (`src/tools/weather.ts` →
 * `export const weather = {...}`). Flat placement then yields `weather.*`,
 * which is what the docs promise. That convention is load-bearing and unenforced,
 * so it is pinned here rather than assumed.
 */

const dirs: string[] = []
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

type ModuleSpec = { name: string; tools: Record<string, string> }

/** An agent declaring local source modules, each a real directory on disk. */
async function agentWithModules(modules: ModuleSpec[], agentTools: Record<string, string> = {}): Promise<string> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    dirs.push(storeDir, dir)

    const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
    const agent = await platform.projects.create("agent", { name: `test-agent-${crypto.randomUUID().slice(0, 8)}`, dir })

    for (const module of modules) {
        const root = join(agent.root, "modules", module.name)
        await mkdir(join(root, "src", "tools"), { recursive: true })
        await writeFile(join(root, "module.config.ts"), "export default defineModule({})\n")
        for (const [file, source] of Object.entries(module.tools)) {
            await writeFile(join(root, "src", "tools", file), source)
        }
    }

    await mkdir(join(agent.root, "src", "tools"), { recursive: true })
    for (const [file, source] of Object.entries(agentTools)) {
        await writeFile(join(agent.root, "src", "tools", file), source)
    }

    const declared = modules.map(m => `"./modules/${m.name}"`).join(", ")
    await writeFile(
        join(agent.root, "axon.config.ts"),
        `export default defineAgent({ providers: [Mock()], model: "mock:mock", modules: [${declared}] })\n`,
    )

    return agent.root
}

/** The registry convention: one file named after the module, one object of the same name. */
const objectTool = (name: string, body: string) => `export const ${name} = { ${body} }\n`

describe("module tools: reaching the agent's scope", () => {
    it("a module's tool is scanned and tagged with module origin", async () => {
        const root = await agentWithModules([
            { name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } },
        ])

        const { blueprint } = await Blueprint({ root }).load()
        const tool = blueprint.tools?.find(t => t.name === "weather")

        expect(tool?.origin).toBe("module")
        expect(tool?.modulePath).toContain("weather")
    }, 90_000)

    it("the module's namespace is its name, following the registry convention", async () => {
        // src/tools/weather.ts exporting `weather` gives the agent `weather.*`
        // — the shape every registry module ships and the docs describe.
        const root = await agentWithModules([
            { name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } },
        ])

        const { blueprint } = await Blueprint({ root }).load()
        const dts = scopeToDts(toScope(blueprint as never))

        expect(dts).toContain("const weather:")
        expect(dts).toContain("now:")
    }, 90_000)

    it("its declared types travel with it", async () => {
        const root = await agentWithModules([
            {
                name: "weather",
                tools: {
                    "weather.ts": "export type Conditions = { tempC: number }\nexport const weather = { now: async (): Promise<Conditions> => ({ tempC: 20 }) }\n",
                },
            },
        ])

        const { blueprint } = await Blueprint({ root }).load()
        const dts = scopeToDts(toScope(blueprint as never))

        expect(dts).toContain("Conditions")
        expect(dts).toContain("tempC")
    }, 90_000)

    it("the model's scope and the editor's declarations agree about it", async () => {
        const root = await agentWithModules([
            { name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } },
        ])

        const { blueprint } = await Blueprint({ root }).load()
        const scope = toScope(blueprint as never)

        expect(renderScope(scope)).toContain("weather")
        expect(scopeToDts(scope)).toContain("weather")
    }, 90_000)

    it("several modules each contribute their own namespace", async () => {
        const root = await agentWithModules([
            { name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } },
            { name: "tavily", tools: { "tavily.ts": objectTool("tavily", "search: async (q: string): Promise<string[]> => [q]") } },
        ])

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools?.map(t => t.name).sort()).toEqual(["tavily", "weather"])
    }, 90_000)

    it("an agent's own tools and a module's coexist", async () => {
        const root = await agentWithModules(
            [{ name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } }],
            { "mine.ts": "export function mine(): string { return 'ok' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools?.map(t => t.name).sort()).toEqual(["mine", "weather"])
    }, 90_000)
})

/**
 * A broken module degrades; it does not take the agent with it.
 *
 * This suite asserted the opposite — that a module tool which cannot compile
 * fails the load — and the reasoning was sound at the time: a scan warning was
 * committed as `build:warning`, which classified as DEBUG and was therefore
 * invisible at default verbosity. "Warn and skip" was indistinguishable from
 * silence, so crashing was the only way to be heard.
 *
 * That constraint is gone (build:warning is info-level and renders its own
 * card, and a module's failure now reaches the MODEL through
 * scope.unavailable), and the old posture had a cost that mattered more: one
 * bad dependency left the user unable to boot the terminal they needed in
 * order to remove it. Installing a module that fails to compile bricked the
 * agent until the config was hand-edited.
 *
 * The agent's OWN tools still throw — that posture is unchanged and is
 * asserted in the agent-tools suite. The distinction is the whole design: an
 * agent is defined by what its author wrote, and a module is a dependency.
 */
describe("module tools: failures degrade the module, not the agent", () => {
    it("a module tool that cannot compile still loads the agent", async () => {
        const root = await agentWithModules([
            { name: "broken", tools: { "broken.ts": "import { gone } from './nowhere'\nexport const broken = { f: () => gone }\n" } },
        ])

        const { blueprint } = await Blueprint({ root }).load()

        // Booted. This is the property the whole change exists for.
        expect(blueprint.modules?.map(m => m.name)).toContain("broken")
    }, 90_000)

    it("the broken module is marked degraded, with the reason", async () => {
        const root = await agentWithModules([
            { name: "broken", tools: { "broken.ts": "import { gone } from './nowhere'\nexport const broken = { f: () => gone }\n" } },
        ])

        const { blueprint } = await Blueprint({ root }).load()
        const broken = blueprint.modules?.find(m => m.name === "broken")

        // Not merely absent from the scope — NAMED, because the model reads
        // this to say "I cannot do that right now" instead of guessing.
        expect(broken?.degraded).toBeTruthy()
    }, 90_000)

    it("its tools are absent from the scope", async () => {
        const root = await agentWithModules([
            { name: "broken", tools: { "broken.ts": "import { gone } from './nowhere'\nexport const broken = { f: () => gone }\n" } },
        ])

        const { blueprint } = await Blueprint({ root }).load()

        // The invariant that keeps degradation honest: a tool whose source the
        // capsule cannot load must never appear in scope, or the model calls
        // something that does not exist.
        expect(blueprint.tools?.map(t => t.name) ?? []).not.toContain("broken")
    }, 90_000)

    it("the failure names the module's file", async () => {
        const root = await agentWithModules([
            { name: "broken", tools: { "broken.ts": "import { gone } from './nowhere'\nexport const broken = { f: () => gone }\n" } },
        ])

        const { warnings } = await Blueprint({ root }).load()

        expect(warnings.some(w => w.error.includes("broken"))).toBe(true)
    }, 90_000)

    it("one broken module does not cost the agent a working one", async () => {
        const root = await agentWithModules([
            { name: "weather", tools: { "weather.ts": objectTool("weather", "now: async (): Promise<string> => 'sunny'") } },
            { name: "broken", tools: { "broken.ts": "import { gone } from './nowhere'\nexport const broken = { f: () => gone }\n" } },
        ])

        const { blueprint } = await Blueprint({ root }).load()

        // The old behaviour lost BOTH. Isolation is per module: a dependency
        // that will not compile has nothing to do with the one beside it.
        expect(blueprint.tools?.map(t => t.name)).toContain("weather")
        expect(blueprint.tools?.map(t => t.name) ?? []).not.toContain("broken")
    }, 90_000)

    it("a module with no tools at all is not an error", async () => {
        const root = await agentWithModules([{ name: "empty", tools: {} }])

        const { blueprint } = await Blueprint({ root }).load()

        expect(blueprint.tools ?? []).toEqual([])
    }, 90_000)
})
