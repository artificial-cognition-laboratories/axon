import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COGNET_GLOBALS, generateCognetDts } from "../../src/build/project/typegen/cognet-dts"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-components-"))
    await mkdir(join(dir, "cognet", "src", "L0", "map"), { recursive: true })
    await mkdir(join(dir, "cognet", "src", "L0", "look"), { recursive: true })
    await writeFile(join(dir, "cognet", "cognet.config.ts"), "export default defineCognet({ mode: { kind: \"invocation\" } })\n")
    await writeFile(join(dir, "cognet", "src", "L0", "export.ts"), "export const velocity = component<[number, number]>({ public: true })\nexport const body = query({ velocity: velocity })\n")
    await writeFile(join(dir, "cognet", "src", "L0", "map", "components.ts"), "export const usual = component<number>()\n")
    await writeFile(join(dir, "cognet", "src", "L0", "look", "components.ts"), "export const usual = component<number>()\n")
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("generateCognetDts: components", () => {
    it("types components and queries by full name, with unambiguous short names", async () => {
        generateCognetDts(dir, "agent")
        const written = await readFile(join(dir, ".agent", "types", COGNET_GLOBALS), "utf8")

        expect(written).toContain(`"L0/velocity": CognetValue<typeof import("../../cognet/src/L0/export").velocity>`)
        expect(written).toContain(`"velocity": CognetComponents["L0/velocity"]`)
        expect(written).toContain(`"L0/map/usual": CognetValue<typeof import("../../cognet/src/L0/map/components").usual>`)
        expect(written).toContain(`"L0/look/usual": `)
        expect(written).not.toContain(`"usual": `)
        expect(written).toContain(`"L0/body": true`)
        expect(written).toContain(`"body": true`)
    })
})
