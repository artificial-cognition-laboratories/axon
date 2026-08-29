import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Model } from "../../../src/build/project/manifest/model"

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "axon-model-"))
})

afterEach(async () => {
    await rm(root, { recursive: true, force: true })
})

async function config(body: string): Promise<void> {
    await writeFile(join(root, "axon.config.ts"), body)
}

const read = (): Promise<string> => readFile(join(root, "axon.config.ts"), "utf-8")

describe("Model.get", () => {
    it("reads a declared model", async () => {
        await config(`export default defineAgent({\n    model: "codex:gpt-5.6-terra",\n})\n`)

        expect(await Model({ root }).get()).toBe("codex:gpt-5.6-terra")
    })

    it("is null when the agent declares none", async () => {
        await config(`export default defineAgent({\n    modules: ["@axon/fs"],\n})\n`)

        expect(await Model({ root }).get()).toBeNull()
    })

    it("is null when there is no config at all", async () => {
        expect(await Model({ root }).get()).toBeNull()
    })
})

describe("Model.set", () => {
    it("replaces an existing value", async () => {
        await config(`export default defineAgent({\n    model: "axon:auto",\n})\n`)

        const result = await Model({ root }).set("codex:gpt-5.6-terra")

        expect(result.changed).toBe(true)
        expect(await read()).toContain(`model: "codex:gpt-5.6-terra"`)
        expect(await read()).not.toContain("axon:auto")
    })

    it("adds the field when absent", async () => {
        await config(`export default defineAgent({\n    modules: ["@axon/fs"],\n})\n`)

        await Model({ root }).set("axon:auto")
        const text = await read()

        expect(text).toContain(`model: "axon:auto"`)
        expect(text).toContain(`modules: ["@axon/fs"]`)
    })

    it("adds the field to an empty config", async () => {
        await config(`export default defineAgent({})\n`)

        await Model({ root }).set("axon:auto")

        expect(await Model({ root }).get()).toBe("axon:auto")
    })

    it("re-selecting the current model changes nothing", async () => {
        await config(`export default defineAgent({\n    model: "axon:auto",\n})\n`)
        const before = await read()

        const result = await Model({ root }).set("axon:auto")

        expect(result.changed).toBe(false)
        expect(await read()).toBe(before)
    })

    it("leaves the author's comments and formatting alone", async () => {
        await config([
            `// the agent that answers support questions`,
            `export default defineAgent({`,
            `    model: "axon:auto",`,
            ``,
            `    // installed deliberately, in this order`,
            `    modules: [`,
            `        "@axon/fs",`,
            `    ],`,
            `})`,
            ``,
        ].join("\n"))

        await Model({ root }).set("ollama:qwen3:8b")
        const text = await read()

        expect(text).toContain("// the agent that answers support questions")
        expect(text).toContain("// installed deliberately, in this order")
        expect(text).toContain(`model: "ollama:qwen3:8b"`)
    })

    it("survives a config whose other fields nest", async () => {
        await config([
            `export default defineAgent({`,
            `    policy: { process: { run: { allow: ["bun *"] } } },`,
            `    model: "axon:auto",`,
            `})`,
            ``,
        ].join("\n"))

        await Model({ root }).set("codex:gpt-5.6-terra")
        const text = await read()

        expect(await Model({ root }).get()).toBe("codex:gpt-5.6-terra")
        expect(text).toContain(`allow: ["bun *"]`)
    })

    it("refuses a config with no defineAgent call rather than writing something wrong", async () => {
        await config(`export const notAnAgent = 1\n`)

        await expect(Model({ root }).set("axon:auto")).rejects.toThrow()
    })

    it("round-trips a value containing colons and slashes", async () => {
        await config(`export default defineAgent({})\n`)

        await Model({ root }).set("openrouter:anthropic/claude-sonnet-4-6")

        expect(await Model({ root }).get()).toBe("openrouter:anthropic/claude-sonnet-4-6")
    })
})
