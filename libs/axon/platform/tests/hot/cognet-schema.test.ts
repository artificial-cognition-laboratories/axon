import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "../../src/build/blueprint/cognet/schema"

/** Where the runtime's own schema resolves from: this package's installed @arcforge/cognet. */
const AGENT = join(import.meta.dir, "..", "..")

let dir: string
let source: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "axon-schema-"))
    source = join(dir, "cognet")
    await mkdir(join(source, "src", "sense", "eye"), { recursive: true })
    await mkdir(join(source, "src", "control"), { recursive: true })
    await mkdir(join(dir, ".agent", "cognet"), { recursive: true })
    // A frame still written by hand, as during a migration.
    await writeFile(join(source, "src", "sense", "eye", "eye.ts"), "export const camera = frame({ kind: \"metric2d\" })\n")
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const out = () => join(dir, ".agent", "cognet", "schema")
const schema = (rust: string | null = null) => Schema({ cognet: "@test/cognet", uses: {}, sourceDir: source, agentRoot: AGENT, out: out(), rust: rust, stage: join(dir, "stage") })
const read = (path: string) => readFile(join(out(), path), "utf8")

const CONTROL = `// Control — what the mind obeys.

syntax = "proto3";

package test.control;

import "cognet/cognet.proto";

// Each beat, by the work it paces.
enum BeatName {
  BEAT_NAME_UNSPECIFIED = 0;
  BEAT_NAME_RETINA = 1;
  BEAT_NAME_FAST_TURN = 2;
  BEAT_NAME_ODD = 3 [(cognet.text) = "odd-one"];
}

// One unbroken reckoning.
message Chart {
  enum Because {
    BECAUSE_UNSPECIFIED = 0;
    BECAUSE_START = 1;
  }
  double since = 1;
  Because because = 2;
  optional uint32 life = 3;
  repeated double at = 4 [(cognet.fixed) = 3];
  repeated string tags = 5;
}

message Held {
  uint32 count = 1;
}

message Space {
  option (cognet.frames) = true;

  // The world, as the body woke in it.
  cognet.Frame world = 1 [(cognet.frame) = { kind: KIND_METRIC3D, up: [0, -1, 0] }];
  cognet.Frame odometry = 2 [(cognet.frame) = { kind: KIND_METRIC3D, relative_to: "world", scale: 1 }];
}

message Components {
  option (cognet.components) = true;

  // The chart positions are in right now.
  Chart chart = 1 [(cognet.component) = { display: { domain: DOMAIN_POINT, shape: SHAPE_RECORD, frame: "camera", archetype: ARCHETYPE_POINT, instrument: INSTRUMENT_ANGULAR_VELOCITY } }];
  map<string, Held> timing = 2 [(cognet.keys) = "BeatName"];
  double mood = 3 [(cognet.component) = { display: { domain: DOMAIN_POINT, shape: SHAPE_SCALAR, frame: "world" } }];
  Held private_held = 4;
}
`

describe("Schema: TypeScript source and legacy protobuf through one compiler", () => {
    it("compiles multiple native components from TypeScript, Python and Rust", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        await writeFile(join(source, "types", "shapes", "visual.components.ts"), `interface Waypoint { x: number; y: number }
export interface Target { frame: string; x: number; y: number; at: [number, number]; confidence: number | null }
export interface Route { frame: string; waypoints: Waypoint[] }
`)
        await writeFile(join(source, "types", "shapes", "body.components.rs"), `pub struct Pose { pub frame: String, pub x: f64, pub y: f64, pub at: [f64; 3], pub confidence: Option<f32> }
pub struct Motion { pub dx: f64, pub dy: f64 }
`)
        await writeFile(join(source, "types", "shapes", "thought.components.py"), `class Detection:
    frame: str
    x: float
    at: tuple[float, float]
    confidence: float | None

class Hypothesis:
    detection: Detection
    pose: Pose
    label: str
`)
        const generated = join(dir, "python", "generated")
        const native = join(dir, "native", "src", "schema.rs")
        await Schema({ cognet: "@test/cognet", uses: {}, sourceDir: source, agentRoot: AGENT, out: out(), rust: native, python: generated, stage: join(dir, "stage") }).generate()
        expect(await read("shapes/visual.ts-components.ts")).toContain(`export const route = component<Route>({ display: { domain: "point", shape: "record" } })`)
        expect(await read("shapes/body.rs-components.ts")).toContain(`export const pose = component<Pose>({ display: { domain: "point", shape: "record" } })`)
        expect(await read("shapes/thought.py-components.ts")).toContain(`export const hypothesis = component<Hypothesis>({ display: { domain: "point", shape: "record" } })`)
        expect(await read("shapes/visual.ts-components.types.ts")).toContain("waypoints: Waypoint[]")
        expect(await read("shapes/visual.ts-components.types.ts")).toContain("at: [number, number]")
        expect(await read("shapes/visual.ts-components.types.ts")).toContain("confidence: number | null")
        expect(await read("shapes/body.rs-components.types.ts")).toContain("at: [number, number, number]")
        expect(await read("shapes/thought.py-components.types.ts")).toContain("pose: Pose")
        expect(await read("shapes/thought.py-components.types.ts")).toContain("at: [number, number]")
        expect(await read("shapes/body.rs-components.types.ts")).toContain("confidence: number | null")
        expect(await readFile(native, "utf8")).toContain("pub struct Pose")
        expect(await readFile(join(generated, "cognet_generated", "schema", "shapes", "thought_py_components.py"), "utf8")).toContain("class Hypothesis:")
        const script = "from cognet_generated.world import HYDRATE; p = HYDRATE['shapes/pose']({'frame':'body','x':1,'y':2,'at':[1,2,3],'confidence':None}); print(type(p.at).__name__, len(p.at))"
        const run = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONPATH: `${generated}:${join(AGENT, "..", "cognet", "python")}` }, stdout: "pipe", stderr: "pipe" })
        expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
        expect(new TextDecoder().decode(run.stdout).trim()).toBe("tuple 3")
        const lock = JSON.parse(await readFile(join(source, "components.lock.json"), "utf8"))
        expect(lock.messages["component/shapes/target"].x.number).toBe(2)
    })

    it("reads what a component is, and which exports are frames, from doc tags in every language", async () => {
        await mkdir(join(source, "types", "text"), { recursive: true })
        await writeFile(join(source, "types", "text", "text.components.ts"), `/** What was said. @space sequence */
export interface Session {}

/** Where it sits. @frame session @archetype span */
export interface Span { seq: u32; from: u32; to: u32 }

/** Who said it. */
export type Speaker = string

/** How sure. @range 0 1 */
export type Confidence = f64
`)
        await writeFile(join(source, "types", "text", "mood.components.py"), `class Mood:
    """How it feels. @unit joy @workspace"""
    level: float
`)
        await writeFile(join(source, "types", "text", "pulse.components.rs"), `/// A beat. @instrument power
pub struct Pulse { pub rate: f64 }
`)
        await schema().generate()
        const text = await read("text/text.ts-components.ts")
        expect(text).toContain(`export const span = component<Span>({ display: { domain: "sequence", shape: "record", frame: session, archetype: "span" } })`)
        expect(text).toContain("/** Where it sits. */")
        expect(text).toContain(`export const speaker = component<string>({ display: { domain: "point", shape: "categorical" } })`)
        expect(text).toContain(`export const confidence = component<number>({ display: { domain: "point", shape: "scalar", range: [0,1] } })`)
        expect(text).toContain(`export const session = frame({ kind: "sequence" })`)
        expect(text).not.toContain("component<Session>")
        expect(await read("text/mood.py-components.ts")).toContain(`unit: "joy", workspace: true`)
        expect(await read("text/pulse.rs-components.ts")).toContain(`instrument: "power"`)
    })

    it("refuses an unknown tag, and a frame that holds fields", async () => {
        await mkdir(join(source, "types", "text"), { recursive: true })
        const path = join(source, "types", "text", "text.components.ts")
        await writeFile(path, "/** @archtype span */\nexport type Speaker = string\n")
        await expect(schema().generate()).rejects.toThrow("unknown tag @archtype")
        await writeFile(path, "/** @space sequence */\nexport interface Session { at: u32 }\n")
        await expect(schema().generate()).rejects.toThrow("a frame holds no fields")
    })

    it("keeps field numbers when reordered and reserves removed fields", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        const path = join(source, "types", "shapes", "point.components.ts")
        await writeFile(path, "export interface Point { x: number; y: number }\n")
        await schema().generate()
        await writeFile(path, "export interface Point { y: number; z: number }\n")
        await schema().generate()
        const lock = JSON.parse(await readFile(join(source, "components.lock.json"), "utf8"))
        const fields = lock.messages["component/shapes/point"]
        expect(fields.x).toMatchObject({ number: 1, removed: true })
        expect(fields.y.number).toBe(2)
        expect(fields.z.number).toBe(3)
        await writeFile(path, "export interface Point { y: string; z: number }\n")
        await expect(schema().generate()).rejects.toThrow("wire type changed")
        await writeFile(path, "export interface Point { x: number; y: number; z: number }\n")
        await expect(schema().generate()).rejects.toThrow("this field was removed")
    })

    it("accepts scalar and map type aliases as components", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        const path = join(source, "types", "shapes", "state.components.ts")
        await writeFile(path, "export type Energy = number\nexport type Labels = Record<string, string>\nexport interface URLState { requestID: string }\n")
        await schema().generate()
        expect(await read("shapes/state.ts-components.ts")).toContain(`export const energy = component<number>({ display: { domain: "point", shape: "scalar" } })`)
        expect(await read("shapes/state.ts-components.ts")).toContain(`export const labels = component<Record<string, string>>({ display: { domain: "point", shape: "record" } })`)
        expect(await read("shapes/state.ts-components.ts")).toContain(`export const urlState = component<URLState>({ display: { domain: "point", shape: "record" } })`)
        expect(await read("shapes/state.ts-components.types.ts")).toContain("requestId: string")
        await writeFile(path, "export type Energy = string\nexport type Labels = Record<string, string>\nexport interface URLState { requestID: string }\n")
        await expect(schema().generate()).rejects.toThrow("wire type changed")
    })

    it("rejects overlapping components across languages", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        await writeFile(join(source, "types", "shapes", "one.components.ts"), "export interface Pose { x: number }\n")
        await writeFile(join(source, "types", "shapes", "two.components.py"), "class Pose:\n    x: float\n")
        await expect(schema().generate()).rejects.toThrow("overlaps")
    })

    it("rejects a new component whose name already belongs to a legacy schema", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        await writeFile(join(source, "types", "shapes", "old.ts"), `/** @package test.shapes */
export interface Value { /** @field 1 */ x: number }
/** @components */
export interface Components { /** @field 1 */ pose: Component<Value, {}> }
`)
        await writeFile(join(source, "types", "shapes", "new.components.rs"), "pub struct Pose { pub x: f64 }\n")
        await expect(schema().generate()).rejects.toThrow("overlaps")
    })

    it("resolves an explicitly imported legacy type when other schemas use its name", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        await mkdir(join(source, "types", "other"), { recursive: true })
        await writeFile(join(source, "types", "shapes", "legacy.ts"), `/** @package test.shapes */
export interface Reading { /** @field 1 */ value: number }
`)
        await writeFile(join(source, "types", "other", "legacy.ts"), `/** @package test.other */
export interface Reading { /** @field 1 */ count: number }
`)
        await writeFile(join(source, "types", "shapes", "fresh.components.ts"), `import type { Reading as SenseReading } from "./legacy"
export interface Sample { reading: SenseReading }
`)
        await schema().generate()
        expect(await read("shapes/fresh.ts-components.types.ts")).toContain("reading: Reading")
    })

    it("keeps a component's field identity when its owner changes language", async () => {
        await mkdir(join(source, "types", "shapes"), { recursive: true })
        const tsPath = join(source, "types", "shapes", "point.components.ts")
        await writeFile(tsPath, "export interface Point { x: number; y: number }\n")
        await schema().generate()
        await rm(tsPath)
        await writeFile(join(source, "types", "shapes", "point.components.rs"), "pub struct Point { pub y: f64, pub x: f64 }\n")
        await schema().generate()
        const fields = JSON.parse(await readFile(join(source, "components.lock.json"), "utf8")).messages["component/shapes/point"]
        expect(fields.x.number).toBe(1)
        expect(fields.y.number).toBe(2)
    })

    it("finds a component file beside its systems in src/, named as it would be in types/", async () => {
        await mkdir(join(source, "src", "shapes"), { recursive: true })
        await writeFile(join(source, "src", "shapes", "point.components.ts"), "export interface Point { x: number }\n")
        await schema().generate()
        expect(await read("shapes/point.ts-components.ts")).toContain(`export const point = component<Point>({ display: { domain: "point", shape: "record" } })`)
    })

    it("compiles TypeScript types and named components through protobuf into TS and Rust", async () => {
        await mkdir(join(source, "types", "control"), { recursive: true })
        await writeFile(join(source, "types", "control", "control.ts"), `/** @package test.control */
export type Beat = { /** @field 1 */ count: u32; /** @field 2 */ at: f64 }
export type BeatName = "retina" | "fast-turn"
/** @components */
export interface Components {
    /** @field 1 */ beat: Component<Beat, { display: { domain: "point"; shape: "record" } }>
}
`)
        const path = join(dir, "native", "src", "schema.rs")
        await schema(path).generate()
        expect(await read("control/control.types.ts")).toContain("count: number")
        expect(await read("control/control.ts")).toContain("export const beat = component<Beat>({ display")
        expect(await readFile(path, "utf8")).toContain("pub const BEAT:")
    })

    it("generates importable Python values and typed component accessors", async () => {
        await mkdir(join(source, "types", "control"), { recursive: true })
        await writeFile(join(source, "types", "control", "control.ts"), `/** @package test.control */
export interface Beat { /** @field 1 */ count: u32; /** @field 2 */ at: f64 }
/** @components */
export interface Components { /** @field 1 */ beat: Component<Beat, {}> }
`)
        const generated = join(dir, "python", "generated")
        await Schema({ cognet: "@test/cognet", uses: {}, sourceDir: source, agentRoot: AGENT, out: out(), rust: null, python: generated, stage: join(dir, "stage") }).generate()
        expect(await readFile(join(generated, "cognet_generated", "schema", "control", "control.py"), "utf8")).toContain("class Beat:")
        expect(await readFile(join(generated, "cognet_generated", "world.pyi"), "utf8")).toContain("beat: ComponentView[schema0.Beat]")
        const script = "from cognet_generated.schema.control.control import Beat; from cognet_generated.world import HYDRATE; value = HYDRATE['control/beat']({'count': 2, 'at': 1.5}); print(isinstance(value, Beat), value.count)"
        const run = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONPATH: `${generated}:${join(AGENT, "..", "cognet", "python")}` }, stdout: "pipe", stderr: "pipe" })
        expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
        expect(new TextDecoder().decode(run.stdout).trim()).toBe("True 2")
    })

    it("keeps an existing component schema's paths and inferred field numbers when given the plural suffix", async () => {
        await mkdir(join(source, "types", "control"), { recursive: true })
        await writeFile(join(source, "types", "control", "control.components.ts"), `/** @package test.control */
export interface Beat { count: u32; at: f64 }
export interface Components { beat: Component<Beat, {}> }
`)
        await schema().generate()
        expect(await read("control/control.ts")).toContain("export const beat = component<Beat>()")
        expect(await read("control/control.types.ts")).toContain("count: number")
        expect(await read("control/control.types.ts")).toContain("at: number")
    })

    it("keeps nested identities, string values and typed arrays in TypeScript-authored schemas", async () => {
        await mkdir(join(source, "types", "control"), { recursive: true })
        await writeFile(join(source, "types", "control", "shape.ts"), `/** @package test.control */
import type { Component, u32 } from "@arcforge/cognet/schema"
export type Mode = "fast-turn" | "slow"
export interface Self { /** @field 1 */ state: Mode }
export interface Outer { /** @field 1 */ inner: OuterInner }
/** @nested Outer */
export interface OuterInner { /** @field 1 */ count: u32; /** @field 2 */ values: Float32Array; /** @field 3 */ mode: Mode }
/** @components */
export interface Components { /** @field 1 */ shape: Component<Outer, {}> }
`)
        const path = join(dir, "native", "src", "schema.rs")
        const generated = join(dir, "python", "generated")
        await Schema({ cognet: "@test/cognet", uses: {}, sourceDir: source, agentRoot: AGENT, out: out(), rust: path, python: generated, stage: join(dir, "stage") }).generate()
        expect(await read("control/shape.types.ts")).toContain("values: Float32Array")
        expect(await read("control/shape.types.ts")).toContain(`"fast-turn", "slow"`)
        expect(await readFile(path, "utf8")).toContain("pub struct OuterInner")
        expect(await readFile(path, "utf8")).toContain("pub struct SelfValue")
        expect(await read("control/shape.ts")).toContain("component<Outer>()")
        const script = "from array import array; from cognet_generated.schema.control.shape import Outer, OuterInner, Mode; from cognet_generated.world import HYDRATE; value = HYDRATE['control/shape']({'inner': {'count': 2, 'values': array('f', [1.5]), 'mode': 'fast-turn'}}); print(isinstance(value, Outer), isinstance(value.inner, OuterInner), value.inner.mode == Mode('fast-turn'))"
        const run = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONPATH: `${generated}:${join(AGENT, "..", "cognet", "python")}` }, stdout: "pipe", stderr: "pipe" })
        expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
        expect(new TextDecoder().decode(run.stdout).trim()).toBe("True True True")
    })

    it("rejects runtime code and numbers unannotated fields in types/", async () => {
        await mkdir(join(source, "types", "control"), { recursive: true })
        const path = join(source, "types", "control", "invalid.ts")
        await writeFile(path, `/** @package test.control */\nexport const value = 1\n`)
        await expect(schema().generate()).rejects.toThrow("types/ may contain only imports, interfaces and type aliases")
        await writeFile(path, `/** @package test.control */\nexport interface Value { count: number }\n`)
        await schema().generate()
        expect(await read("control/invalid.types.ts")).toContain("count: number")
    })
    it("writes its types as plain data: enums as lists and unions, messages as types, nested names joined", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), CONTROL)
        await schema().generate()
        const types = await read("control/control.types.ts")

        expect(types).toContain(`export const BeatName = ["retina", "fastTurn", "odd-one"] as const`)
        expect(types).toContain("export type BeatName = (typeof BeatName)[number]")
        expect(types).toContain(`export const ChartBecause = ["start"] as const`)
        expect(types).toContain("    because: ChartBecause")
        expect(types).toContain("    life?: number")
        expect(types).toContain("    at: [number, number, number]")
        expect(types).toContain("    tags: string[]")
        expect(types).toContain("/** One unbroken reckoning. */")
        expect(types).toContain("/** Control — what the mind obeys. */")
        // Plain data: nothing that needs the runtime.
        expect(types).not.toContain("component<")
        expect(types).not.toContain("frame(")
    })

    it("writes its components and frames as handles, with their options, frames imported where they are defined", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), CONTROL)
        await schema().generate()
        const handles = await read("control/control.ts")

        expect(handles).toContain(`import type { BeatName, Chart, Held } from "./control.types"`)
        // A frame still hand-written in the source, imported from where it is defined.
        expect(handles).toContain(`import { camera } from "../../../../cognet/src/sense/eye/eye"`)
        expect(handles).toContain("/** The chart positions are in right now. */")
        expect(handles).toContain(`export const chart = component<Chart>({ display: { domain: "point", shape: "record", instrument: "angular-velocity", frame: camera, archetype: "point" } })`)
        expect(handles).toContain("export const timing = component<Partial<Record<BeatName, Held>>>()")
        expect(handles).toContain(`export const mood = component<number>({ display: { domain: "point", shape: "scalar", frame: world } })`)
        expect(handles).toContain("export const privateHeld = component<Held>()")
        expect(handles).toContain(`export const world = frame({ kind: "metric3d", up: [0,-1,0] })`)
        expect(handles).toContain(`export const odometry = frame({ kind: "metric3d", relativeTo: world, scale: 1 })`)
    })

    it("writes a tagged union, a list that may be absent, and a value that may be null, as the values already are", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";
package test.control;
import "cognet/cognet.proto";
message Orthographic { double scale = 1; }
message Perspective { double fov = 1; }
// How a picture lies on the world.
message Lens {
  option (cognet.union) = "kind";
  oneof lens {
    Orthographic orthographic = 1;
    Perspective perspective = 2;
  }
}
message Grid {
  repeated string labels = 1 [(cognet.optional) = true];
  optional uint32 track = 2 [(cognet.nullable) = true];
  Lens lens = 3;
}
message Components {
  option (cognet.components) = true;
  Grid grid = 1;
}
`)
        const generated = join(dir, "python", "generated")
        await Schema({ cognet: "@test/cognet", uses: {}, sourceDir: source, agentRoot: AGENT, out: out(), rust: null, python: generated, stage: join(dir, "stage") }).generate()
        const types = await read("control/control.types.ts")

        expect(types).toContain(`export type Lens =\n      ({ kind: "orthographic" } & Orthographic)\n    | ({ kind: "perspective" } & Perspective)`)
        expect(types).toContain("    labels?: string[]")
        expect(types).toContain("    track?: number | null")
        expect(types).toContain("    lens: Lens")
        const script = "from cognet_generated.schema.control.control import Grid, LensPerspective; from cognet_generated.world import HYDRATE; from cognet.runtime import UNSET; value = HYDRATE['control/grid']({'track': None, 'lens': {'kind': 'perspective', 'fov': 1.5}}); print(isinstance(value, Grid), isinstance(value.lens, LensPerspective), value.labels is UNSET, value.track is None)"
        const run = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONPATH: `${generated}:${join(AGENT, "..", "cognet", "python")}` }, stdout: "pipe", stderr: "pipe" })
        expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
        expect(new TextDecoder().decode(run.stdout).trim()).toBe("True True True True")
    })

    it("refuses a oneof outside a union", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nimport "cognet/cognet.proto";\nmessage Either { oneof which { double a = 1; string b = 2; } }\n`)
        await expect(schema().generate()).rejects.toThrow("a oneof is a union")
    })

    it("writes the schemas' Rust when asked: serde shaped exactly as the TypeScript values are", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), CONTROL)
        await writeFile(join(source, "src", "control", "lens.proto"), `syntax = "proto3";
package test.lens;
import "cognet/cognet.proto";
message Orthographic { double scale = 1; }
message Perspective { double fov = 1; }
message Lens {
  option (cognet.union) = "kind";
  oneof lens {
    Orthographic orthographic = 1;
    Perspective perspective = 2;
  }
}
message Entity {
  uint32 track = 1 [(cognet.nullable) = true];
  optional double maybe = 2 [(cognet.nullable) = true];
  double relative_to = 3;
  repeated double move = 4;
  repeated double points = 5 [(cognet.array) = true];
  repeated int32 labels = 6 [(cognet.array) = true];
}
`)
        const path = join(dir, "native", "src", "schema.rs")
        await schema(path).generate()
        const rs = await readFile(path, "utf8")

        expect(rs).toContain("pub mod control {")
        expect(rs).toMatch(/#\[serde\(rename = "fastTurn"\)\]\s+FastTurn,/)
        expect(rs).toContain(`    #[serde(rename = "odd-one")]`)
        expect(rs).toContain("pub const ALL: [Self; 3] = [Self::Retina, Self::FastTurn, Self::Odd];")
        expect(rs).toContain("pub at: [f64; 3],")
        expect(rs).toContain("pub life: Option<u32>,")
        expect(rs).toContain(`pub const TIMING: ::cognet::Component<::std::collections::BTreeMap<crate::schema::control::control::BeatName, crate::schema::control::control::Held>> = ::cognet::Component::new("control/timing");`)
        expect(rs).toContain(`#[serde(tag = "kind")]`)
        expect(rs).toContain("Perspective(crate::schema::control::lens::Perspective),")
        // Required but may be null; absent or null; and a field whose JSON name is not its own.
        expect(rs).toContain("pub track: Option<u32>,")
        expect(rs).toContain(`with = "::cognet::absent_or_null"`)
        expect(rs).toContain(`#[serde(rename = "relativeTo")]`)
        // A keyword is set apart in Rust and keeps its name in JSON: written as `move_`, the TypeScript would read nothing.
        expect(rs).toMatch(/#\[serde\(rename = "move"\)\]\s+pub move_: Vec<f64>,/)
        // Arrays are blocks in both languages.
        expect(rs).toContain("pub points: ::cognet::Array<f64>,")
        expect(rs).toContain("pub labels: ::cognet::Array<i32>,")
        const ts = await readFile(join(out(), "control", "lens.types.ts"), "utf8")
        expect(ts).toContain("points: Float64Array")
        expect(ts).toContain("labels: Int32Array")
    })

    it("refuses an array of what is not a number, or of a fixed length", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nimport "cognet/cognet.proto";\nmessage Wide { repeated string at = 1 [(cognet.array) = true]; }\n`)
        await expect(schema().generate()).rejects.toThrow("Wide.at: (cognet.array) is for a repeated double, float, int32 or uint32")
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nimport "cognet/cognet.proto";\nmessage Wide { repeated double at = 1 [(cognet.array) = true, (cognet.fixed) = 3]; }\n`)
        await expect(schema().generate()).rejects.toThrow("(cognet.array) — a block of any length — or (cognet.fixed), not both")
    })

    it("refuses a 64-bit integer, which cannot cross as JSON, naming the field", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nimport "cognet/cognet.proto";\nmessage Wide { int64 at = 1; }\n`)
        await expect(schema().generate()).rejects.toThrow("control/control.proto, Wide.at: a 64-bit integer cannot cross as JSON")
    })

    it("refuses a display in a frame no one declares", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nimport "cognet/cognet.proto";\nmessage Components {\n  option (cognet.components) = true;\n  double mood = 1 [(cognet.component) = { display: { frame: "nowhere" } }];\n}\n`)
        await expect(schema().generate()).rejects.toThrow(`no frame is named "nowhere"`)
    })

    it("says what buf says when a schema does not compile", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), `syntax = "proto3";\npackage test.control;\nmessage Broken { Missing at = 1; }\n`)
        await expect(schema().generate()).rejects.toThrow("Missing")
    })

    it("writes only into its own folder, and clears from it whatever no schema generates now", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), CONTROL)
        await schema().generate()
        expect(existsSync(join(source, "src", "control", "control.pb.ts"))).toBe(false)
        await rm(join(source, "src", "control", "control.proto"))
        await schema().generate()

        expect(existsSync(join(out(), "control", "control.ts"))).toBe(false)
        expect(existsSync(join(out(), "control", "control.types.ts"))).toBe(false)
    })

    it("removes what an older build generated beside a schema, and never a module it did not write", async () => {
        await writeFile(join(source, "src", "control", "control.proto"), CONTROL)
        await writeFile(join(source, "src", "control", "control.pb.ts"), "// Generated by axon prepare from control/control.proto — edit the schema, not this file.\n")
        await writeFile(join(source, "src", "control", "mine.pb.ts"), "export const mine = 1\n")
        await schema().generate()

        expect(existsSync(join(source, "src", "control", "control.pb.ts"))).toBe(false)
        expect(existsSync(join(source, "src", "control", "mine.pb.ts"))).toBe(true)
    })
})
