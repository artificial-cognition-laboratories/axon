import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServiceUse } from "@arcforge/types"
import { Schema } from "../../src/build/blueprint/cognet/schema"

/** Where the runtime — its schema and its standard interfaces — resolves from: this package's installed @arcforge/cognet. */
const AGENT = join(import.meta.dir, "..", "..")

let dir: string
let source: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-interfaces-"))
    source = join(dir, "cognet")
    await mkdir(join(source, "interfaces"), { recursive: true })
    await mkdir(join(source, "src", "sense"), { recursive: true })
    await writeFile(join(source, "src", "sense", "sense.components.ts"), `
/** What the eye last saw. */
export interface Picture {
    width: u32
    height: u32
    rgb: Uint8Array
}
`)
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const SCENE = `
import type { Picture } from "../src/sense/sense.components"
import type { Nearness } from "@arcforge/cognet/interfaces/depth-relative@1"

/** Every surface in view. */
export interface Scene {
    describe(): { maxSurfaces: u32; gpu: boolean }

    /** Encodes what is in view. */
    encode(picture: Picture, nearness: Nearness): Promise<SceneCode>

    /** The surface under a point. */
    surface(scene: SceneCode, at: [f64, f64]): Promise<Surface>

    /** Follows the scene as the camera moves. */
    follow(): Session<Picture, Changes>

    /** Every surface, as it is found. */
    surfaces(scene: SceneCode): AsyncIterable<Surface>

    forget(scene: SceneCode): Promise<void>
}

export type SceneCode = Handle<"SceneCode">

interface Surface { normal: [f64, f64, f64]; distance: f64 }
interface Changes { moved: Surface[] }
`

const schema = (uses: Record<string, ServiceUse>) => Schema({
    cognet: "@cody/terry",
    uses: uses,
    sourceDir: source,
    agentRoot: AGENT,
    out: join(dir, ".agent", "cognet", "schema"),
    rust: join(dir, "native", "src", "schema.rs"),
    python: join(dir, "python", "generated"),
    stage: join(dir, "stage"),
})

describe("interfaces", () => {
    it("compiles the cognet's own and the standard ones it uses, each method's kind from its return", async () => {
        await writeFile(join(source, "interfaces", "scene@1.interface.ts"), SCENE)

        const { interfaces } = await schema({
            scene: { interface: "./interfaces/scene@1" },
            depth: { interface: "depth-relative@1", optional: true },
            main: { interface: "chat@1" },
        }).generate()

        const byName = Object.fromEntries(interfaces.map(one => [one.name, one]))
        expect(Object.keys(byName).sort()).toEqual(["@cody/terry/scene@1", "chat@1", "depth-relative@1"])
        expect(byName["@cody/terry/scene@1"]).toEqual({
            name: "@cody/terry/scene@1",
            written: "./interfaces/scene@1",
            methods: {
                describe: { kind: "describe", params: [] },
                encode: { kind: "call", params: ["picture", "nearness"] },
                surface: { kind: "call", params: ["scene", "at"] },
                follow: { kind: "session", params: [] },
                surfaces: { kind: "stream", params: ["scene"] },
                forget: { kind: "call", params: ["scene"] },
            },
            conformance: null,
        })
        // The standard library ships its cases; this cognet's own interface ships none.
        expect(byName["chat@1"]!.conformance).toEndWith("chat@1.conformance")
        expect(byName["chat@1"]!.methods).toEqual({ describe: { kind: "describe", params: [] }, request: { kind: "call", params: ["conversation"] }, stream: { kind: "stream", params: ["conversation"] } })
    })

    it("generates its value types and handles in every language", async () => {
        await writeFile(join(source, "interfaces", "scene@1.interface.ts"), SCENE)

        await schema({ scene: { interface: "./interfaces/scene@1" } }).generate()

        const rust = await readFile(join(dir, "native", "src", "schema.rs"), "utf8")
        expect(rust).toContain("pub struct Surface")
        expect(rust).toContain("pub struct SceneCode")
        expect(rust).toContain("pub struct Nearness")
        const types = await readFile(join(dir, ".agent", "cognet", "schema", "interfaces", "scene.v1.types.ts"), "utf8")
        expect(types).toContain("normal: [number, number, number]")
        const python = await readFile(join(dir, "python", "generated", "cognet_generated", "schema", "interfaces", "scene_v1.py"), "utf8")
        expect(python).toContain("class Surface:")
    })

    it("refuses a use naming an interface that doesn't exist", async () => {
        await expect(schema({ depth: { interface: "depth-psychic@1" } }).generate()).rejects.toMatchObject({ code: "AX-COGNET-032" })
        await expect(schema({ scene: { interface: "./interfaces/scene@1" } }).generate()).rejects.toThrow(/interfaces\/scene@1\.interface\.ts/)
    })

    it("refuses an interface without describe()", async () => {
        await writeFile(join(source, "interfaces", "mute@1.interface.ts"), "export interface Mute { hush(): Promise<void> }\n")
        await expect(schema({}).generate()).rejects.toThrow(/every interface declares describe\(\)/)
    })

    it("refuses a method of no kind", async () => {
        await writeFile(join(source, "interfaces", "odd@1.interface.ts"), "export interface Odd { describe(): {}; now(): u32 }\n")
        await expect(schema({}).generate()).rejects.toThrow(/Odd\.now: must return Promise<T>, AsyncIterable<T> or Session<Push, Answer>/)
    })

    it("refuses two interfaces in one file, and an interface in a file not named for it", async () => {
        await writeFile(join(source, "interfaces", "two@1.interface.ts"), "export interface A { describe(): {} }\nexport interface B { describe(): {} }\n")
        await expect(schema({}).generate()).rejects.toThrow(/exactly one interface/)
        await rm(join(source, "interfaces", "two@1.interface.ts"))
        await writeFile(join(source, "interfaces", "helpers.ts"), "export interface Helper { describe(): {} }\n")
        await expect(schema({}).generate()).rejects.toThrow(/named for it and its major version/)
    })

    it("refuses a session that opens with arguments", async () => {
        await writeFile(join(source, "interfaces", "vad@1.interface.ts"), `
import type { Picture } from "../src/sense/sense.components"
export interface Vad { describe(): {}; open(rate: u32): Session<Picture, Picture> }
`)
        await expect(schema({}).generate()).rejects.toThrow(/a session opens with no arguments/)
    })
})
