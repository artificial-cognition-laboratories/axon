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
 * When an agent and its modules claim the same name.
 *
 * There are TWO kinds of collision here and only one of them was ever handled.
 *
 * merge() resolves collisions between TOOL names — the filename. An agent's
 * `weather.ts` and a module's `weather.ts` are the same name, so the agent wins
 * and the module's is skipped with a warning. That path worked.
 *
 * What it cannot see is two DIFFERENTLY-named files whose exports collide: an
 * agent's `weather.ts` and a module's `forecast.ts` both exporting `now()`.
 * Those are distinct tools by merge()'s reckoning, so both survived — and both
 * install flat, so `tool-globals.d.ts` and the model's <scope> each declared
 * `function now()` twice while the capsule's Object.assign silently kept
 * whichever loaded last. Two declarations of one global, no warning, and an
 * export the author wrote unreachable.
 *
 * toScope() now dedupes flat members by callable name with the agent winning,
 * which is the same precedence merge() applies one level up.
 */

const dirs: string[] = []
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

type ModuleSpec = { name: string; tools: Record<string, string> }

async function agentWithModules(modules: ModuleSpec[], agentTools: Record<string, string> = {}) {
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

/** How many times a declaration for `name` appears in a rendered block. */
const declarationCount = (rendered: string, name: string) =>
    rendered.split(new RegExp(`function\\s+${name}\\s*\\(`)).length - 1

describe("collisions: same tool name (the filename)", () => {
    it("the agent's tool wins and the module's is skipped", async () => {
        const root = await agentWithModules(
            [{ name: "weather", tools: { "weather.ts": "export const weather = { now: async (): Promise<string> => 'module' }\n" } }],
            { "weather.ts": "export const weather = { now: async (): Promise<string> => 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()
        const weather = blueprint.tools?.filter(t => t.name === "weather") ?? []

        expect(weather).toHaveLength(1)
        expect(weather[0]?.origin).toBe("src")
    }, 90_000)

    it("the shadowing is reported rather than silent", async () => {
        const root = await agentWithModules(
            [{ name: "weather", tools: { "weather.ts": "export const weather = { now: async (): Promise<string> => 'module' }\n" } }],
            { "weather.ts": "export const weather = { now: async (): Promise<string> => 'agent' }\n" },
        )

        const { warnings } = await Blueprint({ root }).load()
        const shadowed = warnings.filter(w => w.domain === "tools")

        expect(shadowed).toHaveLength(1)
        expect(shadowed[0]?.error).toContain("weather")
    }, 90_000)

    it("two modules claiming one tool name resolve by declaration order", async () => {
        const root = await agentWithModules([
            { name: "alpha", tools: { "search.ts": "export const search = { run: async (): Promise<string> => 'alpha' }\n" } },
            { name: "beta", tools: { "search.ts": "export const search = { run: async (): Promise<string> => 'beta' }\n" } },
        ])

        const { blueprint, warnings } = await Blueprint({ root }).load()

        expect(blueprint.tools?.filter(t => t.name === "search")).toHaveLength(1)
        expect(warnings.filter(w => w.domain === "tools")).toHaveLength(1)
    }, 90_000)
})

describe("collisions: same callable name across different files", () => {
    it("a name is declared once, not twice, in the editor's declarations", async () => {
        // The bug: different tool names, colliding function names. merge() sees
        // two distinct tools and keeps both; without deduping at the scope level
        // this rendered `function now()` twice in one declare global block.
        const root = await agentWithModules(
            [{ name: "weather", tools: { "forecast.ts": "export function now(): string { return 'module' }\n" } }],
            { "weather.ts": "export function now(): string { return 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()
        const dts = scopeToDts(toScope(blueprint as never))

        expect(declarationCount(dts, "now")).toBe(1)
    }, 90_000)

    it("a name is declared once in the model's scope too", async () => {
        const root = await agentWithModules(
            [{ name: "weather", tools: { "forecast.ts": "export function now(): string { return 'module' }\n" } }],
            { "weather.ts": "export function now(): string { return 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()

        expect(declarationCount(renderScope(toScope(blueprint as never)), "now")).toBe(1)
    }, 90_000)

    it("the agent's export is the one that survives", async () => {
        // Same precedence merge() applies to tool names — the author's own code
        // is never displaced by something they installed.
        const root = await agentWithModules(
            [{ name: "weather", tools: { "forecast.ts": "export function now(): string { return 'module' }\n" } }],
            { "weather.ts": "export function now(): string { return 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()
        const scope = toScope(blueprint as never)
        const owner = scope.modules.find(m => m.members.some(mem => mem.name === "now"))

        expect(owner?.name).toBe("weather")
        expect(blueprint.tools?.find(t => t.name === "weather")?.origin).toBe("src")
    }, 90_000)

    it("the module's other exports are unaffected by one colliding name", async () => {
        // Deduping is per member, not per tool: losing `now` must not cost the
        // module the rest of its surface.
        const root = await agentWithModules(
            [{ name: "weather", tools: { "forecast.ts": "export function now(): string { return 'module' }\nexport function tomorrow(): string { return 'module' }\n" } }],
            { "weather.ts": "export function now(): string { return 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()
        const dts = scopeToDts(toScope(blueprint as never))

        expect(dts).toContain("tomorrow")
        expect(declarationCount(dts, "now")).toBe(1)
    }, 90_000)

    it("two modules colliding on a callable name declare it once", async () => {
        const root = await agentWithModules([
            { name: "alpha", tools: { "a.ts": "export function run(): string { return 'alpha' }\n" } },
            { name: "beta", tools: { "b.ts": "export function run(): string { return 'beta' }\n" } },
        ])

        const { blueprint } = await Blueprint({ root }).load()

        expect(declarationCount(scopeToDts(toScope(blueprint as never)), "run")).toBe(1)
    }, 90_000)

    it("no collision means both names survive", async () => {
        // The counterweight — deduping must not eat distinct names.
        const root = await agentWithModules(
            [{ name: "weather", tools: { "forecast.ts": "export function tomorrow(): string { return 'module' }\n" } }],
            { "weather.ts": "export function now(): string { return 'agent' }\n" },
        )

        const { blueprint } = await Blueprint({ root }).load()
        const dts = scopeToDts(toScope(blueprint as never))

        expect(dts).toContain("now")
        expect(dts).toContain("tomorrow")
    }, 90_000)
})
