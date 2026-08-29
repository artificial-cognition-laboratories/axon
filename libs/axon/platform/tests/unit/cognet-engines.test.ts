import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCognetEngines } from "../../src/build/blueprint"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-engines-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

async function config(body: string): Promise<void> {
    await writeFile(join(dir, "cognet.config.ts"), body)
}

describe("readCognetEngines", () => {
    it("reads a single role with its constraints", async () => {
        await config(`
            export default defineCognet({
                name: "zero",
                engines: {
                    main: {
                        type: "generate",
                        in: "text",
                        out: "text",
                        context: 100_000,
                        structured: true,
                        primary: true,
                    },
                },
            })
        `)

        expect(await readCognetEngines(dir)).toEqual({
            main: {
                type: "generate",
                in: ["text"],
                out: ["text"],
                context: 100_000,
                structured: true,
                primary: true,
            },
        })
    })

    it("reads several roles without the first closing brace ending the block", async () => {
        await config(`
            export default defineCognet({
                engines: {
                    main:    { type: "generate", in: "text", out: "text" },
                    percept: { type: "generate", in: "text", out: "text", optional: true },
                    vad:     { type: "stream", in: "audio", out: "score" },
                },
            })
        `)

        const engines = await readCognetEngines(dir)

        expect(Object.keys(engines)).toEqual(["main", "percept", "vad"])
        expect(engines.vad?.type).toBe("stream")
        expect(engines.percept?.optional).toBe(true)
    })

    it("reads array modalities", async () => {
        await config(`
            export default defineCognet({
                engines: {
                    vision: { type: "generate", in: ["text", "image"], out: ["text"] },
                },
            })
        `)

        const engines = await readCognetEngines(dir)

        expect(engines.vision?.in).toEqual(["text", "image"])
        expect(engines.vision?.out).toEqual(["text"])
    })

    it("keeps numeric separators out of the value", async () => {
        await config(`
            export default defineCognet({
                engines: { main: { type: "generate", in: "text", out: "text", context: 200_000 } },
            })
        `)

        expect((await readCognetEngines(dir)).main?.context).toBe(200_000)
    })

    it("survives a block that follows models:", async () => {
        await config(`
            export default defineCognet({
                models: { vad: "hf:onnx-community/silero-vad/onnx/model.onnx" },
                engines: { main: { type: "generate", in: "text", out: "text" } },
            })
        `)

        expect(Object.keys(await readCognetEngines(dir))).toEqual(["main"])
    })

    it("drops a role that declares no type rather than guessing one", async () => {
        await config(`
            export default defineCognet({
                engines: { main: { in: "text", out: "text", context: 100_000 } },
            })
        `)

        expect(await readCognetEngines(dir)).toEqual({})
    })

    it("drops a role missing a modality", async () => {
        await config(`
            export default defineCognet({
                engines: { main: { type: "generate", in: "text" } },
            })
        `)

        expect(await readCognetEngines(dir)).toEqual({})
    })

    it("a cognet declaring no engines yields none", async () => {
        await config(`export default defineCognet({ name: "zero", mode: { kind: "invocation" } })`)

        expect(await readCognetEngines(dir)).toEqual({})
    })

    it("a missing config is empty, not a throw", async () => {
        expect(await readCognetEngines(join(dir, "nowhere"))).toEqual({})
    })

    it("comments between roles do not break the scan", async () => {
        await config(`
            export default defineCognet({
                engines: {
                    // the cortex — what the picker edits
                    main: { type: "generate", in: "text", out: "text", primary: true },
                    // fanned out, absent on a small machine
                    percept: { type: "generate", in: "text", out: "text", parallel: true, optional: true },
                },
            })
        `)

        const engines = await readCognetEngines(dir)

        expect(Object.keys(engines)).toEqual(["main", "percept"])
        expect(engines.percept?.parallel).toBe(true)
    })
})
