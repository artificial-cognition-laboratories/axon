import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { CognetDefinition, KernelAbi } from "@arcforge/types"
import { bundleCognet } from "../../src/build/blueprint/cognet/bundle"

/**
 * A brain made of `*.system.ts` files, compiled for real: discovered wherever
 * they sit, their components named from where they are defined, and run by
 * the host with no main.ts at all.
 *
 * Built under this package rather than the OS temp dir, so the bundler
 * resolves `@arcforge/cognet` to the workspace host being tested.
 */

const ROOT = join(import.meta.dir, ".cognet-systems")

afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
})

async function brain(files: Record<string, string>): Promise<{ agent: string; source: string }> {
    await mkdir(ROOT, { recursive: true })
    const agent = await mkdtemp(join(ROOT, "agent-"))
    const source = join(agent, "cognet")
    await writeFile(join(agent, "package.json"), JSON.stringify({ name: "systems-test", version: "1.0.0" }))
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(source, path, ".."), { recursive: true })
        await writeFile(join(source, path), content)
    }
    return { agent: agent, source: source }
}

async function compile(files: Record<string, string>): Promise<CognetDefinition> {
    const { agent, source } = await brain(files)
    const artifact = await bundleCognet({ sourceDir: source, agentRoot: agent, inline: true })
    const module = await import(`${pathToFileURL(artifact.blueprint.path).href}?v=${artifact.blueprint.hash}`)
    return module.default as CognetDefinition
}

const CONFIG = `export default defineCognet({ mode: { kind: "invocation" } })\n`

/** What a kernel says about the body and the sandbox — stable, as a real kernel's is until something changes. */
const SCOPE = { modules: [], unavailable: [] }
const STATE = { body: () => null, presence: () => null, scope: () => SCOPE, emit: () => {}, services: { state: () => ({}) } }
const PRESENCE = { state: "embodied" }

describe("compiling a brain of systems", () => {
    test("discovers nested systems, names components by folder, and runs them in data order", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "L0/vision/components.ts": [
                "export const count = component<number>()",
                "export const echo = component<number>()",
            ].join("\n"),
            // Deeper than its components: a system belongs wherever its code is.
            "L0/vision/motion/count.system.ts": [
                `import { count } from "../components"`,
                "export default defineSystem({",
                "    once: true,",
                "    recalls: [count],",
                "    writes: [count],",
                "    run() {",
                `        ecs.set({ id: "self", components: { count: (ecs.query({ components: ["count"] })[0]?.count ?? 0) + 1 } })`,
                `        ;(globalThis as any).${trace}.push("count:" + count.name)`,
                "    },",
                "})",
            ].join("\n"),
            "L1/echo.system.ts": [
                `import { echo, count } from "../L0/vision/components"`,
                "export default defineSystem({",
                "    reads: [echo],",
                "    writes: [],",
                `    run() { (globalThis as any).${trace}.push("echo") },`,
                "})",
            ].join("\n"),
            "L0/vision/echo.system.ts": [
                `import { count, echo } from "./components"`,
                "export default defineSystem({",
                "    reads: [count],",
                "    writes: [echo],",
                `    run() { ecs.set({ id: "self", components: { echo: ecs.query({ components: ["count"] })[0]!.count } }) },`,
                "})",
            ].join("\n"),
        })

        const seen: string[] = []
        ;(globalThis as Record<string, unknown>)[trace] = seen
        const abi = { ...STATE, emit: () => {} } as unknown as KernelAbi
        await definition.load(abi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })

        // count → vision echo → L1 echo: the order is the data's, not the files'.
        expect(seen).toEqual(["count:L0/vision/count", "echo"])
        await definition.unload?.()
    }, 30_000)

    test("names code under src/ from src/, not from the cognet root", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "src/L0/body/components.ts": "export const beat = component<number>()",
            "src/L0/body/pulse.system.ts": [
                `import { beat } from "./components"`,
                "export default defineSystem({",
                "    once: true,",
                "    writes: [beat],",
                `    run() { (globalThis as any).${trace}.push(beat.name + " by " + "L0/body/pulse"); ecs.set({ id: "self", components: { beat: 1 } }) },`,
                "})",
            ].join("\n"),
        })
        const seen: string[] = []
        ;(globalThis as Record<string, unknown>)[trace] = seen
        const events: Array<{ type: string; data: any }> = []
        await definition.load({ ...STATE, emit: (type: string, data: unknown) => { events.push({ type: type, data: data }) } } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(seen).toEqual(["L0/body/beat by L0/body/pulse"])
        const declared = events.find(event => event.type === "cognet:schedule:declare")!.data
        expect(declared.systems.map((system: { name: string }) => system.name)).toEqual(["L0/body/pulse"])
        await definition.unload?.()
    }, 30_000)

    test("an async system's result lands and is read within the same invocation wake", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "mind/components.ts": "export const reply = component<string>()",
            "mind/think.system.ts": [
                `import { reply } from "./components"`,
                "export default defineSystem({",
                "    once: true,",
                "    writes: [reply],",
                "    async run() {",
                "        await new Promise(resolve => setTimeout(resolve, 5))",
                `        ecs.set({ id: "self", components: { reply: "hello" } })`,
                "    },",
                "})",
            ].join("\n"),
            "mind/speak.system.ts": [
                `import { reply } from "./components"`,
                "export default defineSystem({",
                "    reads: [reply],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ["reply"] })[0]?.reply ?? "(silence)") },`,
                "})",
            ].join("\n"),
        })

        const said: string[] = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })

        expect(said).toEqual(["(silence)", "hello"])
        await definition.unload?.()
    }, 30_000)

    test("runs a Python system through the schedule and lands its writes", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/mind/mind.ts": `/** @package test.mind */
export interface Answer { /** @field 1 */ text: string }
/** @components */
export interface Components { /** @field 1 */ answer: Component<Answer, {}> }`,
            "mind/answer.system.py": [
                "from cognet import system",
                "from cognet_generated.world import Run",
                "from cognet_generated.schema.mind.mind import Answer",
                "@system(once=True, writes=['answer'])",
                "def run(ctx: Run) -> None:",
                "    ctx.ecs.write('self').answer(Answer(text='from Python')).commit()",
            ].join("\n"),
            "mind/read.system.ts": [
                `import { answer } from "#schema/mind/mind"`,
                "export default defineSystem({",
                "    reads: [answer],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ["answer"] })[0]?.answer.text) },`,
                "})",
            ].join("\n"),
        })
        const said: Array<string | undefined> = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said).toEqual([undefined, "from Python"])
        await definition.unload?.()
    }, 30_000)

    test("lets a Python system read the body's presence and act through the kernel", async () => {
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/mind/mind.ts": `/** @package test.mind */
export interface Answer { /** @field 1 */ text: string }
/** @components */
export interface Components { /** @field 1 */ answer: Component<Answer, {}> }`,
            "mind/speak.system.py": [
                "from cognet import system",
                "from cognet_generated.world import Run",
                "@system(once=True, writes=['answer'])",
                "def run(ctx: Run) -> None:",
                "    ctx.kernel.output('text', channel='/chat', content='I am ' + ctx.kernel.presence().state)",
                "    ctx.kernel.emit('cognet:log:info', {'value': 'spoke'})",
            ].join("\n"),
        })
        const outputs: unknown[] = []
        const emitted: unknown[] = []
        await definition.load({
            ...STATE,
            presence: () => PRESENCE,
            output: async (type: string, data: unknown) => { outputs.push([type, data]) },
            emit: (type: string, data: unknown) => { if (type === "cognet:log:info") emitted.push(data) },
        } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(outputs).toEqual([["cognet:output:text", { channel: "/chat", content: "I am embodied" }]])
        expect(emitted).toEqual([{ value: "spoke" }])
        await definition.unload?.()
    }, 30_000)

    test("lets an async Python system call a service and ask the kernel: arrays both ways, and a refusal by its code", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { depth: { interface: "depth-relative@1", optional: true } } })\n`,
            "types/mind/mind.components.ts": "export interface Seen { nearness: Float32Array; maxSide: u32; missing: string }\n",
            "mind/look.system.py": [
                "from cognet import KernelError, system",
                "@system(once=True, writes=['seen'], uses=['depth'])",
                "async def run(ctx) -> None:",
                "    assert ctx.services.depth.available",
                "    found = await ctx.services.depth.call('estimate', picture={'width': 2, 'height': 1, 'rgb': bytes([1, 2, 3, 4, 5, 6])})",
                "    try:",
                "        await ctx.kernel.knowledge.read('nowhere.md')",
                "        missing = 'read'",
                "    except KernelError as refused:",
                "        missing = refused.code",
                "    ctx.ecs.write('self').seen({'nearness': found.nearness, 'maxSide': ctx.services.depth.describe().maxSide, 'missing': missing}).commit()",
            ].join("\n"),
        })
        const asked: Array<[string, string, { picture: { rgb: Uint8Array } }]> = []
        await definition.load({
            ...STATE,
            services: {
                state: () => ({ depth: { available: true, describe: { maxSide: 518 } } }),
                call: async (use: string, method: string, args: { picture: { rgb: Uint8Array } }) => {
                    asked.push([use, method, args])
                    return { width: 2, height: 1, nearness: Float32Array.from([args.picture.rgb[0]!, args.picture.rgb[3]!], value => value / 10) }
                },
            },
            knowledge: { read: async () => { throw Object.assign(new Error("no such entry"), { code: "AX-KNOWLEDGE-001" }) } },
        } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        const world = (globalThis as unknown as { ecs: { query(q: unknown): Array<{ seen: { nearness: Float32Array; maxSide: number; missing: string } }> } }).ecs
        const [row] = world.query({ components: ["seen"] })
        expect(asked.map(([use, method]) => [use, method])).toEqual([["depth", "estimate"]])
        expect(asked[0]![2].picture.rgb).toBeInstanceOf(Uint8Array)
        expect([...row!.seen.nearness]).toEqual([Math.fround(0.1), Math.fround(0.4)])
        expect(row!.seen.maxSide).toBe(518)
        expect(row!.seen.missing).toBe("AX-KNOWLEDGE-001")
        await definition.unload?.()
    }, 30_000)

    test("hands a TypeScript system the uses it declared, typed by interface: a call, a handle released with its run, and a use it never declared refused", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { segment: { interface: "segment@1", optional: true }, depth: { interface: "depth-relative@1", optional: true } } })\n`,
            "types/mind/mind.components.ts": "export interface Found { score: f64; maxSide: u32; refused: string }\n",
            "mind/look.system.ts": [
                "export default defineSystem({",
                "    once: true,",
                "    writes: [\"found\"],",
                "    uses: [\"segment\"],",
                "    async run(run) {",
                "        const picture = { width: 2, height: 1, rgb: new Uint8Array(6) }",
                "        const encoded = await run.services.segment.encode(picture)",
                "        const mask = await run.services.segment.mask(encoded, { point: [1, 0] })",
                "        let refused = \"reached\"",
                "        try { (run.services as Record<string, unknown>).depth } catch (cause) { refused = (cause as { code: string }).code }",
                "        ecs.set({ id: \"self\", components: { found: { score: mask.score, maxSide: run.services.segment.describe()!.maxSide, refused: refused } } })",
                "    },",
                "})",
            ].join("\n"),
        })
        const asked: Array<[string, string, Record<string, unknown>]> = []
        const released: string[] = []
        await definition.load({
            ...STATE,
            services: {
                state: () => ({ segment: { available: true, describe: { maxSide: 1024 } }, depth: { available: false, describe: null } }),
                call: async (use: string, method: string, args: Record<string, unknown>) => {
                    asked.push([use, method, args])
                    return method === "encode" ? { handle: "Encoded", id: "segment:1" } : { width: 2, height: 1, mask: new Uint8Array(2), score: 0.9 }
                },
                release: async (handle: string) => { released.push(handle) },
            },
        } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        const world = (globalThis as unknown as { ecs: { query(q: unknown): Array<{ found: { score: number; maxSide: number; refused: string } }> } }).ecs
        const [row] = world.query({ components: ["found"] })
        expect(asked.map(([use, method]) => `${use}.${method}`)).toEqual(["segment.encode", "segment.mask"])
        // Positional arguments cross as one object keyed by the interface's parameter names, the handle as itself.
        expect(Object.keys(asked[0]![2])).toEqual(["picture"])
        expect(asked[1]![2]).toEqual({ encoded: { handle: "Encoded", id: "segment:1" }, prompt: { point: [1, 0] } })
        expect(row!.found).toEqual({ score: 0.9, maxSide: 1024, refused: "AX-COGNET-019" })
        // The run kept its handle: it was let go when the run ended.
        expect(released).toEqual(["segment:1"])
        await definition.unload?.()
    }, 30_000)

    test("names an inline brain's own interfaces after its agent, and carries each use's interface and cases on the blueprint", async () => {
        const { agent, source } = await brain({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "continuous", hz: 20 }, uses: { features: { interface: "./interfaces/features@1", optional: true }, depth: { interface: "depth-relative@1", optional: true } } })\n`,
            "interfaces/features@1.interface.ts": "export interface Features { describe(): { patch: u32 }; extract(picture: Picture): Promise<Grid> }\nexport interface Picture { width: u32; height: u32; rgb: Uint8Array }\nexport interface Grid { rows: u32; cols: u32; descriptors: Float32Array }\n",
            "interfaces/features@1.conformance/cases.json": "[]\n",
            "types/mind/mind.components.ts": "export interface Seen { cells: u32 }\n",
            "mind/look.system.ts": "export default defineSystem({ once: true, writes: [\"seen\"], uses: [\"features\"], async run() {} })\n",
        })
        const artifact = await bundleCognet({ sourceDir: source, agentRoot: agent, inline: true })
        const uses = artifact.blueprint.uses!
        expect(uses.features!.named).toBe("systems-test/features@1")
        expect(uses.features!.methods.extract).toEqual({ kind: "call", params: ["picture"] })
        expect(uses.features!.conformance).toBe(join(source, "interfaces", "features@1.conformance"))
        expect(uses.depth!.named).toBe("depth-relative@1")
        expect(uses.depth!.conformance).toEndWith("depth-relative@1.conformance")
    }, 30_000)

    test("a brain reused from another project's compile carries this project's own paths to its cases", async () => {
        const files = {
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { features: { interface: "./interfaces/features@1", optional: true } } })\n`,
            "interfaces/features@1.interface.ts": "export interface Features { describe(): {}; extract(width: u32): Promise<Grid> }\nexport interface Grid { cells: u32 }\n",
            "interfaces/features@1.conformance/cases.json": "[]\n",
            "types/mind/mind.components.ts": "export interface Seen { cells: u32 }\n",
            "mind/look.system.ts": `export default defineSystem({ once: true, writes: ["seen"], uses: ["features"], async run() { /* ${Math.random()} */ } })\n`,
        }
        const first = await brain(files)
        const second = await brain(files)
        await bundleCognet({ sourceDir: first.source, agentRoot: first.agent, inline: true })
        const reused = await bundleCognet({ sourceDir: second.source, agentRoot: second.agent, inline: true })
        expect(reused.blueprint.uses!.features!.conformance).toBe(join(second.source, "interfaces", "features@1.conformance"))
    }, 30_000)

    test("runs Python's async systems side by side: one waiting on the kernel holds up no other", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { slow: { interface: "embed@1" } } })\n`,
            "types/mind/mind.components.ts": "export interface Waited { done: boolean }\nexport interface Quick { done: boolean }\n",
            "mind/wait.system.py": [
                "from cognet import system",
                "@system(once=True, writes=['waited'], uses=['slow'])",
                "async def run(ctx) -> None:",
                "    await ctx.services.slow.call('text', text='x')",
                "    ctx.kernel.output('text', channel='/log', content='slow')",
            ].join("\n"),
            "mind/quick.system.py": [
                "from cognet import system",
                "@system(once=True, writes=['quick'])",
                "async def run(ctx) -> None:",
                "    ctx.kernel.output('text', channel='/log', content='quick')",
            ].join("\n"),
        })
        const said: string[] = []
        await definition.load({
            ...STATE,
            services: { state: () => ({ slow: { available: true, describe: null } }), call: () => new Promise(resolve => setTimeout(() => resolve({ vector: [] }), 300)) },
            output: async (_type: string, data: { content: string }) => { said.push(data.content) },
        } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said).toEqual(["quick", "slow"])
        await definition.unload?.()
    }, 30_000)

    test("cancels a Python run waiting on the kernel when its wake is cancelled", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { slow: { interface: "embed@1" } } })\n`,
            "types/mind/mind.components.ts": "export interface Waited { done: boolean }\n",
            "mind/wait.system.py": [
                "from cognet import system",
                "@system(once=True, writes=['waited'], uses=['slow'])",
                "async def run(ctx) -> None:",
                "    await ctx.services.slow.call('text', text='x')",
                "    ctx.kernel.output('text', channel='/log', content='finished')",
            ].join("\n"),
        })
        const said: string[] = []
        const asked = Promise.withResolvers<void>()
        await definition.load({
            ...STATE,
            services: { state: () => ({ slow: { available: true, describe: null } }), call: () => { asked.resolve(); return new Promise(resolve => setTimeout(() => resolve({ vector: [] }), 2_000)) } },
            output: async (_type: string, data: { content: string }) => { said.push(data.content) },
        } as unknown as KernelAbi)
        const cancel = new AbortController()
        const waking = definition.wake({ stimuli: [], signal: cancel.signal })
        await asked.promise
        cancel.abort()
        await waking.catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 2_500))
        expect(said).toEqual([])
        await definition.unload?.()
    }, 30_000)

    test("runs a Python system using a TypeScript-authored component without schema annotations", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/mind/answer.components.ts": "export interface Answer { text: string }\n",
            "mind/answer.system.py": [
                "from cognet import system",
                "from cognet_generated.world import Run",
                "from cognet_generated.schema.mind.answer_ts_components import Answer",
                "@system(once=True, writes=['answer'])",
                "def run(ctx: Run) -> None:",
                "    ctx.ecs.write('self').answer(Answer(text='from native source')).commit()",
            ].join("\n"),
            "mind/read.system.ts": [
                'import { answer } from "#schema/mind/answer.ts-components"',
                "export default defineSystem({",
                "    reads: [answer],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ["answer"] })[0]?.answer.text) },`,
                "})",
            ].join("\n"),
        })
        const said: Array<string | undefined> = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said).toEqual([undefined, "from native source"])
        await definition.unload?.()
    }, 30_000)

    test("runs systems over Rust- and Python-authored components", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/mind/count.components.rs": "pub struct Count { pub n: u32 }\n",
            "types/mind/reply.components.py": "class Reply:\n    text: str\n",
            "mind/seed.system.ts": [
                'import { count } from "#schema/mind/count.rs-components"',
                "export default defineSystem({ once: true, writes: [count],",
                "    run() { ecs.set({ id: 'self', components: { count: { n: 7 } } }) },",
                "})",
            ].join("\n"),
            "mind/reply.system.ts": [
                'import { count } from "#schema/mind/count.rs-components"',
                'import { reply } from "#schema/mind/reply.py-components"',
                "export default defineSystem({ reads: [count], writes: [reply],",
                "    run() { const value = ecs.query({ components: ['count'] })[0]?.count; if (value) ecs.set({ id: 'self', components: { reply: { text: String(value.n) } } }) },",
                "})",
            ].join("\n"),
            "mind/read.system.ts": [
                'import { reply } from "#schema/mind/reply.py-components"',
                "export default defineSystem({ reads: [reply],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ['reply'] })[0]?.reply.text) },`,
                "})",
            ].join("\n"),
        })
        const said: Array<string | undefined> = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said.at(-1)).toBe("7")
        await definition.unload?.()
    }, 30_000)

    test("moves a typed image block through a Python system", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/visual/visual.ts": `/** @package test.visual */
export interface Plane { /** @field 1 */ values: Float32Array }
/** @components */
export interface Components { /** @field 1 */ image: Component<Plane, {}> }`,
            "visual/draw.system.py": [
                "from array import array",
                "from cognet import system",
                "from cognet_generated.world import Run",
                "from cognet_generated.schema.visual.visual import Plane",
                "@system(once=True, writes=['image'])",
                "def run(ctx: Run) -> None:",
                "    ctx.ecs.write('self').image(Plane(values=array('f', [1.25, 2.5]))).commit()",
            ].join("\n"),
            "visual/read.system.ts": [
                `import { image } from "#schema/visual/visual"`,
                "export default defineSystem({",
                "    reads: [image],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ["image"] })[0]?.image.values) },`,
                "})",
            ].join("\n"),
        })
        const said: Array<Float32Array | undefined> = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said[0]).toBeUndefined()
        expect(said[1]).toEqual(new Float32Array([1.25, 2.5]))
        await definition.unload?.()
    }, 30_000)

    test("lets Python read a component and import a local helper", async () => {
        const trace = `__trace_${Math.random().toString(36).slice(2)}`
        const definition = await compile({
            "cognet.config.ts": CONFIG,
            "types/mind/mind.ts": `/** @package test.mind */
export interface Count { /** @field 1 */ n: number }
export interface Answer { /** @field 1 */ text: string }
/** @components */
export interface Components { /** @field 1 */ count: Component<Count, {}>; /** @field 2 */ answer: Component<Answer, {}> }`,
            "mind/helper.py": "def answer(n):\n    return f'number {n}'\n",
            "mind/seed.system.ts": [
                `import { count } from "#schema/mind/mind"`,
                "export default defineSystem({ once: true, writes: [count],",
                "    run() { ecs.set({ id: 'self', components: { count: { n: 7 } } }) },",
                "})",
            ].join("\n"),
            "mind/answer.system.py": [
                "from cognet import system",
                "from cognet_generated.world import Run",
                "from cognet_generated.schema.mind.mind import Answer",
                "from mind.helper import answer",
                "from dataclasses import is_dataclass",
                "@system(reads=['count'], writes=['answer'])",
                "def run(ctx: Run) -> None:",
                "    found = ctx.ecs.count.first()",
                "    if found is None:",
                "        raise ValueError('count was not given')",
                "    entity, count = found",
                "    if not is_dataclass(count):",
                "        raise TypeError('read value is not the generated dataclass')",
                "    if not ctx.ecs.has(entity):",
                "        raise ValueError('entity was not given')",
                "    ctx.ecs.write(entity).answer(Answer(text=answer(count.n))).commit()",
            ].join("\n"),
            "mind/read.system.ts": [
                `import { answer } from "#schema/mind/mind"`,
                "export default defineSystem({ reads: [answer],",
                `    run() { (globalThis as any).${trace}.push(ecs.query({ components: ['answer'] })[0]?.answer.text) },`,
                "})",
            ].join("\n"),
        })
        const said: Array<string | undefined> = []
        ;(globalThis as Record<string, unknown>)[trace] = said
        await definition.load({ ...STATE, emit: () => {} } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        expect(said.at(-1)).toBe("number 7")
        await definition.unload?.()
    }, 30_000)

    test("refuses a brain with no script and no systems", async () => {
        await expect(compile({ "cognet.config.ts": CONFIG })).rejects.toMatchObject({ code: "AX-COGNET-004" })
    }, 30_000)
})
