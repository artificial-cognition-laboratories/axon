/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE WORLD CONTRACT — atrium.world/0                       2026-10-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * How whoever runs a world — axond's lab, a test, a person at a terminal —
 * runs it: puts bodies in it, takes them out, sets how its time passes,
 * steps it, keeps its state and returns to it. Exported from @arcforge/types
 * as the `world` namespace (`world.Request`).
 *
 * The body contract (`body`) is the mind's side of a world: one body, worn.
 * This is the other side: the world itself, whole. A mind never speaks it.
 *
 * THE SHAPE
 *
 *   runner ── spawns ──► world process   (one process, one world)
 *     stdin   ── Request ──►               one JSON object a line, each with an `id`
 *     stdout  ◄── Said ───                  `ready` first; a `reply` or `failed` per request; events between
 *
 *   A body placed answers where a mind wears it (`BodyState.bridge`): the
 *   body contract, over a WebSocket, one mind a body.
 *
 * WHY IT IS SHAPED THIS WAY
 *
 *   1. One process a world, run over its own pipes. Booting one is cheap —
 *      a baked world loads in a fraction of a second — so worlds are made
 *      and thrown away rather than pooled; a world that diverges takes down
 *      only itself; and when the runner goes its stdin closes and the world
 *      ends with it. Nothing outlives what started it.
 *
 *   2. The world is loaded as the process starts and never swapped: another
 *      world is another process. So there is no `load`.
 *
 *   3. Time is the runner's to set. `real` keeps to the wall, `scaled` to a
 *      factor of it, and `stepped` moves only when stepped — by the runner
 *      (`step`), or by a mind through its body (the body contract's `Step`).
 *      A stepped world waits for its mind: however slowly a mind thinks, it
 *      lives in a world that never outruns it.
 *
 *   4. State is kept whole and returned to exactly (`snapshot`, `restore`):
 *      the same state stepped the same way gives the same world. A snapshot
 *      fits the world only while the same bodies are placed; placing or
 *      removing one forgets every snapshot.
 *
 *   5. Everything refused is refused by code (`Code`), never ignored: a
 *      request that is not of the contract, a body the library has not, a
 *      step while running in real time.
 *
 * SPOKEN BY
 *
 *   Atrium (`apps/atrium`), Axon's own lab: MuJoCo physics, bodies and
 *   worlds imported from MJCF, URDF, USD, glTF and OBJ. The Rust side of these
 *   types is `apps/atrium/src/world/wire.rs`; they are the source of truth.
 */

import type { Pace } from "../body/body"

export const CONTRACT = "atrium.world/0"

// ═══════════════════════════════════════════════════════════════════════════
//  1. REQUESTS — what the runner asks
// ═══════════════════════════════════════════════════════════════════════════

export type Request = Place | Remove | SetPace | Step | Reset | Snapshot | Restore | State | Close

/**
 * A body from the world's library, placed as `name`: its base `at` (m, the
 * world's axes, z up) — or, without `at`, stood on whatever is below the
 * world's spawn, beside the bodies already there — turned `yaw` (rad) about
 * up. Its joints stand at rest. With a `token`, only a mind presenting it
 * (`?token=` on the bridge) may wear it: a lease's.
 */
export type Place = { type: "place"; id: number; body: string; name: string; at?: [number, number, number]; yaw?: number; token?: string }

/** The body placed as `name` taken out; its mind, if it has one, told why and let go. */
export type Remove = { type: "remove"; id: number; name: string }

export type SetPace = { type: "pace"; id: number; pace: Pace }

/** `steps` physics steps (the body contract's clock `step` each), at a stepped pace only. Answered once taken. */
export type Step = { type: "step"; id: number; steps: number }

/** Back to the world as loaded: every body at its placement, its joints at rest. */
export type Reset = { type: "reset"; id: number }

/** The world's whole physical state kept; answered with its id. */
export type Snapshot = { type: "snapshot"; id: number }

export type Restore = { type: "restore"; id: number; snapshot: number }

/** What the world is now. */
export type State = { type: "state"; id: number }

/** The world ends: every mind told, then the process exits. */
export type Close = { type: "close"; id: number }

// ═══════════════════════════════════════════════════════════════════════════
//  2. WHAT THE WORLD SAYS
// ═══════════════════════════════════════════════════════════════════════════

export type Said = Ready | Reply | Failed | Event | Ticked

/**
 * The first line: the world is loaded and listening. `bridge` is where minds
 * connect — a body at `<bridge>/<name>` — and `view` where a viewer watches
 * the whole world (`View`, below).
 */
export type Ready = {
    type: "ready"
    contract: typeof CONTRACT
    /** The world process's own version. */
    version: string
    /** The physics engine's. */
    mujoco: string
    world: string
    bridge: string
    view: string
    /** One physics step, s. */
    timestep: number
    pace: Pace
}

/** A request done. What `result` holds is each request's own (below). */
export type Reply = { type: "reply"; id: number; result: unknown }

/** A request refused — or, with no `id`, a line that was no request at all. */
export type Failed = { type: "failed"; id: number | null; code: Code; message: string }

/**
 * Something the runner should know, unasked:
 *
 *   unsound   the physics went wrong — a NaN, a huge velocity — and the
 *             world was put back at rest
 *   behind    the world fell behind the wall and let the time go: it is
 *             heavier than real time on this machine
 *   refused   a mind broke the body contract, and was let go
 */
export type Event = { type: "event"; kind: "unsound" | "behind" | "refused"; detail: string; time: number }

/** Once a second: the world's time, and how many of its seconds pass in a wall second. */
export type Ticked = { type: "ticked"; time: number; factor: number }

export type Code =
    | "BODY_NOT_FOUND"
    | "WORLD_NOT_FOUND"
    | "IMPORT_UNSUPPORTED"
    | "IMPORT_FAILED"
    | "CONTRACT_UNSAID"
    | "PHYSICS"
    | "REFUSED"
    | "WIRE"
    | "IO"

// ── results ───────────────────────────────────────────────────────────────

/** `place`'s result, and each body `state` lists. */
export type BodyState = {
    name: string
    /** Which body of the library it is. */
    body: string
    /** Where a mind wears it: the body contract, over a WebSocket. */
    bridge: string
    worn: boolean
    /** How many joints it moves. */
    joints: number
}

export type StateResult = { world: string; time: number; pace: Pace; bodies: BodyState[] }

// ═══════════════════════════════════════════════════════════════════════════
//  3. THE VIEW — the whole world, for whoever watches it
// ═══════════════════════════════════════════════════════════════════════════
//
//  On `Ready.view`, a WebSocket that only speaks:
//
//    text    a `ViewScene` — what is drawn — said again whenever a body is
//            placed or taken out (geoms are numbered afresh)
//    binary  VIEW_MESHES: the scene's meshes, in its order — each one's
//            vertices (f32 × 3), then its triangles (u32 × 3)
//    binary  VIEW_FRAME: [tag u32][count u32][time f64], then for each of
//            the scene's `moving` geoms in order, and then each of its
//            `eyes`, pos (f32 × 3) and its 3×3 turn row by row (f32 × 9).
//            `count` is the geoms'. An eye looks down its own −z, its y up.
//
//  Little-endian; every binary message begins with its tag.

export const VIEW_MESHES = 1
export const VIEW_FRAME = 2

/** One geom, as drawn. */
export type ViewGeom = {
    id: number
    /** The placed body it is part of, by its placement's name — null for scenery and props. */
    placed: string | null
    /** The part of that body (or the prop) it is on. */
    part: string
    shape: "plane" | "sphere" | "capsule" | "ellipsoid" | "cylinder" | "box" | "mesh"
    /** MuJoCo's size parameters, as the shape reads them: a box's half-sizes; a sphere's radius; a capsule's or cylinder's radius and half-length; a plane's half-extents (0: endless). */
    size: [number, number, number]
    /** Which of the scene's meshes, for a mesh. */
    mesh?: number
    rgba: [number, number, number, number]
    /** Where it is as the scene is said, and its 3×3 turn, row by row. */
    pos: [number, number, number]
    mat: [number, number, number, number, number, number, number, number, number]
}

export type ViewScene = {
    type: "scene"
    world: string
    time: number
    geoms: ViewGeom[]
    /** Each mesh's vertex and triangle counts, in the order VIEW_MESHES holds them. */
    meshes: Array<[number, number]>
    /** The ids of the geoms a frame moves, in its order. */
    moving: number[]
    /** Every placed body's eyes — the cameras it sees through — in the order a frame places them after the geoms. */
    eyes: ViewEye[]
}

/** A body's eye: where a viewer looks from to see as the body sees. */
export type ViewEye = { placed: string; name: string; fovy: number }
export type SnapshotResult = { snapshot: number; time: number }
export type TimeResult = { time: number }
