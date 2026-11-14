import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CognetConfigFile } from "../../src/build/blueprint"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-cognet-config-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

async function read(body: string) {
    await writeFile(join(dir, "cognet.config.ts"), body)
    return CognetConfigFile({ sourceDir: dir }).read()
}

describe("cognet.config.ts, read statically", () => {
    it("reads every config in the registry", async () => {
        // The real configs are the contract: a reader that rejects one breaks that cognet's prepare.
        const registry = join(import.meta.dir, "../../../../../registry")
        const dirs = [
            ...readdirSync(join(registry, "agents")).map(name => join(registry, "agents", name, "cognet")),
            ...readdirSync(join(registry, "cognets")).map(name => join(registry, "cognets", name)),
        ].filter(one => existsSync(join(one, "cognet.config.ts")))

        expect(dirs.length).toBeGreaterThan(4)
        for (const one of dirs) expect(CognetConfigFile({ sourceDir: one }).read()?.mode).toBeDefined()
    })

    it("is null for a cognet without one", () => {
        expect(CognetConfigFile({ sourceDir: join(dir, "nowhere") }).read()).toBeNull()
    })

    it("reads uses and suggests", async () => {
        const config = await read(`
            export default defineCognet({
                mode: { kind: "continuous", hz: 20 },
                uses: {
                    main: { interface: "chat@1", requires: { context: { min: 100_000 }, modalities: { includes: ["image"] } } },
                    depth: { interface: "depth-metric@1", optional: true },
                    scene: { interface: "./interfaces/scene@1", requires: { gpu: true } },
                },
                suggests: { depth: "@axon/depth-pro" },
            })
        `)

        expect(config?.uses).toEqual({
            main: { interface: "chat@1", requires: { context: { min: 100_000 }, modalities: { includes: ["image"] } } },
            depth: { interface: "depth-metric@1", optional: true },
            scene: { interface: "./interfaces/scene@1", requires: { gpu: true } },
        })
        expect(config?.suggests).toEqual({ depth: "@axon/depth-pro" })
    })

    it("reads the models a use names, its primary, and how many at once", async () => {
        const config = await read(`
            export default defineCognet({
                mode: { kind: "continuous", hz: 20 },
                uses: {
                    main: { interface: "chat@1", primary: true },
                    small: { interface: "chat@1", model: ["google/gemini-2.5-flash", "qwen3:8b"], parallel: 4, optional: true },
                    jev: { interface: "chat@1", model: "anthropic/claude-haiku-4.5" },
                },
            })
        `)

        expect(config?.uses).toEqual({
            main: { interface: "chat@1", primary: true },
            small: { interface: "chat@1", model: ["google/gemini-2.5-flash", "qwen3:8b"], parallel: 4, optional: true },
            jev: { interface: "chat@1", model: "anthropic/claude-haiku-4.5" },
        })
    })

    it("refuses a model list it can't bind from, and more than one primary", async () => {
        const uses = (body: string) => read(`export default defineCognet({ mode: { kind: "invocation" }, uses: { ${body} } })`)
        await expect(uses(`small: { interface: "chat@1", model: [] }`)).rejects.toThrow(/`uses\.small\.model` must be a model id, or a list/)
        await expect(uses(`small: { interface: "chat@1", model: ["a/b", "a/b"] }`)).rejects.toThrow(/`uses\.small\.model\[1\]` must be named once/)
        await expect(uses(`small: { interface: "chat@1", parallel: 2.5 }`)).rejects.toThrow(/`uses\.small\.parallel` must be a whole number above 0/)
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, engines: { main: { type: "generate", in: "text", out: "text", primary: true } }, uses: { voice: { interface: "chat@1", primary: true } } })`)).rejects.toThrow(/`uses\.voice` must be the only primary — engines\.main already is/)
    })

    it("reads engines with modalities as lists, through comments and nested blocks", async () => {
        const config = await read(`
            export default defineCognet({
                mode: { kind: "invocation" },
                models: { vad: "hf:onnx-community/silero-vad/onnx/model.onnx" },
                engines: {
                    // the cortex
                    main: { type: "generate", in: "text", prefer: { in: "image" }, out: "text", context: 200_000, primary: true },
                    vision: { type: "generate", in: ["text", "image"], out: ["text"], optional: true },
                },
            })
        `)

        expect(config?.engines).toEqual({
            main: { type: "generate", in: ["text"], prefer: { in: ["image"] }, out: ["text"], context: 200_000, primary: true },
            vision: { type: "generate", in: ["text", "image"], out: ["text"], optional: true },
        })
    })

    it("reads the object form of a model, pins included", async () => {
        const config = await read(`
            export default defineCognet({
                mode: { kind: "invocation" },
                models: {
                    features: { hf: "onnx-community/dinov2-small", set: true, in: ["image"] },
                    asr: { hf: "onnx-community/whisper-tiny.en", file: "onnx/model.onnx", rev: "abc123", sha256: "deadbeef" },
                },
            })
        `)

        expect(config?.models).toEqual({
            features: { hf: "onnx-community/dinov2-small", set: true, in: ["image"] },
            asr: { hf: "onnx-community/whisper-tiny.en", file: "onnx/model.onnx", rev: "abc123", sha256: "deadbeef" },
        })
    })

    it("sees through a top-level const, as const and satisfies", async () => {
        const config = await read(`
            const HZ = 20
            const mode = { kind: "continuous", hz: HZ } as const
            export default defineCognet({ mode, threads: (0 satisfies number), abi: \`12\` })
        `)

        expect(config).toEqual({ mode: { kind: "continuous", hz: 20 }, threads: 0, abi: "12" })
    })

    it("refuses a value that must be computed, naming the field and line", async () => {
        const reading = read(`export default defineCognet({
    mode: { kind: "continuous", hz: rate() },
})`)

        await expect(reading).rejects.toMatchObject({ code: "AX-COGNET-030" })
        await expect(reading).rejects.toThrow(/cognet\.config\.ts:2: `mode\.hz` is `rate\(\)`/)
    })

    it("refuses an import, a spread and undefined", async () => {
        await expect(read(`import { HZ } from "./rate"\nexport default defineCognet({ mode: { kind: "continuous", hz: HZ } })`)).rejects.toThrow(/not a top-level const/)
        await expect(read(`const base = {}\nexport default defineCognet({ ...base, mode: { kind: "invocation" } })`)).rejects.toThrow(/write the value out/)
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, abi: undefined })`)).rejects.toThrow(/leave the field out/)
    })

    it("refuses a field it doesn't have, rather than skipping it", async () => {
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, engine: "main" })`)).rejects.toMatchObject({ code: "AX-COGNET-031" })
    })

    it("refuses a field of the wrong shape", async () => {
        await expect(read(`export default defineCognet({ mode: { kind: "continuous" } })`)).rejects.toThrow(/`mode\.hz` must be a number above 0/)
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, engines: { main: { type: "generate", in: "text" } } })`)).rejects.toThrow(/`engines\.main\.out` must be a list/)
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, uses: { depth: { interface: "depth-metric" } } })`)).rejects.toThrow(/major version/)
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, uses: { main: { interface: "chat@1", requires: { context: { least: 1 } } } } })`)).rejects.toThrow(/`uses\.main\.requires\.context` must be/)
    })

    it("refuses a suggestion for a use it never declared", async () => {
        await expect(read(`export default defineCognet({ mode: { kind: "invocation" }, suggests: { depth: "@axon/depth-pro" } })`)).rejects.toThrow(/`suggests\.depth` must be a use declared/)
    })

    it("refuses a config with no mode, or no defineCognet", async () => {
        await expect(read(`export default defineCognet({ threads: 2 })`)).rejects.toThrow(/`mode` must be present/)
        await expect(read(`export default { mode: { kind: "invocation" } }`)).rejects.toThrow(/defineCognet/)
    })
})
