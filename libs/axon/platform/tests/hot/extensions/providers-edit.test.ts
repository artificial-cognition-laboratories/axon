import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addProvider, readProviders, removeProvider } from "../../../src/build/extensions/edit"

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "axon-providers-"))
})

afterEach(async () => {
    await rm(root, { recursive: true, force: true })
})

async function config(body: string): Promise<void> {
    await writeFile(join(root, "profile.config.ts"), body)
}

const read = (): Promise<string> => readFile(join(root, "profile.config.ts"), "utf-8")

describe("readProviders", () => {
    it("reads the declared factories in order", async () => {
        await config(`export default defineProfile({\n    providers: [Axon(), Codex()],\n})\n`)

        expect(await readProviders(root)).toEqual(["Axon", "Codex"])
    })

    it("reads a factory carrying options", async () => {
        await config(`export default defineProfile({\n    providers: [Ollama({ url: "http://box:11434" })],\n})\n`)

        expect(await readProviders(root)).toEqual(["Ollama"])
    })

    it("is empty when the profile declares none", async () => {
        await config(`export default defineProfile({\n    settings: {},\n})\n`)

        expect(await readProviders(root)).toEqual([])
    })

    it("is empty when there is no config", async () => {
        expect(await readProviders(root)).toEqual([])
    })
})

describe("addProvider", () => {
    it("appends to an existing array", async () => {
        await config(`export default defineProfile({\n    providers: [Axon()],\n})\n`)

        const result = await addProvider(root, "Codex")

        expect(result.changed).toBe(true)
        expect(await readProviders(root)).toEqual(["Axon", "Codex"])
    })

    it("is idempotent — connecting twice declares once", async () => {
        await config(`export default defineProfile({\n    providers: [Axon()],\n})\n`)

        expect((await addProvider(root, "Axon")).changed).toBe(false)
        expect(await readProviders(root)).toEqual(["Axon"])
    })

    it("creates the field when the profile declares none", async () => {
        await config(`export default defineProfile({\n    settings: { theme: "arcnight" },\n})\n`)

        await addProvider(root, "Axon")

        expect(await readProviders(root)).toEqual(["Axon"])
        expect(await read()).toContain(`theme: "arcnight"`)
    })

    it("creates the field on an empty profile", async () => {
        await config(`export default defineProfile({})\n`)

        await addProvider(root, "Axon")

        expect(await readProviders(root)).toEqual(["Axon"])
    })

    it("fills an empty array", async () => {
        await config(`export default defineProfile({\n    providers: [],\n})\n`)

        await addProvider(root, "Ollama")

        expect(await readProviders(root)).toEqual(["Ollama"])
    })

    it("leaves the author's other config and comments alone", async () => {
        await config([
            `export default defineProfile({`,
            `    // themes I actually use`,
            `    extensions: ["@axon/ember-theme"],`,
            ``,
            `    providers: [Axon()],`,
            `})`,
            ``,
        ].join("\n"))

        await addProvider(root, "Codex")
        const text = await read()

        expect(text).toContain("// themes I actually use")
        expect(text).toContain(`extensions: ["@axon/ember-theme"]`)
        expect(await readProviders(root)).toEqual(["Axon", "Codex"])
    })
})

describe("removeProvider", () => {
    it("removes a bare declaration", async () => {
        await config(`export default defineProfile({\n    providers: [Axon(), Codex()],\n})\n`)

        const result = await removeProvider(root, "Codex")

        expect(result.changed).toBe(true)
        expect(await readProviders(root)).toEqual(["Axon"])
    })

    it("KEEPS a declaration the user configured with options", async () => {
        await config(`export default defineProfile({\n    providers: [Ollama({ url: "http://box:11434" })],\n})\n`)

        const result = await removeProvider(root, "Ollama")

        expect(result.changed).toBe(false)
        expect(await read()).toContain("http://box:11434")
    })

    it("removing something absent changes nothing", async () => {
        await config(`export default defineProfile({\n    providers: [Axon()],\n})\n`)

        expect((await removeProvider(root, "Codex")).changed).toBe(false)
    })

    it("removing from a profile with no providers field changes nothing", async () => {
        await config(`export default defineProfile({\n    settings: {},\n})\n`)

        expect((await removeProvider(root, "Codex")).changed).toBe(false)
    })

    it("leaves the array valid when emptied", async () => {
        await config(`export default defineProfile({\n    providers: [Axon()],\n})\n`)

        await removeProvider(root, "Axon")

        expect(await readProviders(root)).toEqual([])
    })
})

describe("reconnecting restores the declaration", () => {
    it("add → remove → add lands back where it started", async () => {
        await config(`export default defineProfile({\n    providers: [Axon()],\n})\n`)

        await addProvider(root, "OpenRouter")
        await removeProvider(root, "OpenRouter")
        await addProvider(root, "OpenRouter")

        expect(await readProviders(root)).toEqual(["Axon", "OpenRouter"])
    })
})
