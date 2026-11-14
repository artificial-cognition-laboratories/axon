# Systems in other languages — design

Status (2026-10-06): the component schema is BUILT (part 2, below) and all of
Terry runs on it, but for a few components still holding hand-written typed
arrays — kept on shared memory, which a schema cannot yet declare.
Rust systems are BUILT (see "Rust systems"): seven of Terry's run as Rust —
`control/rhythm`; the eye's `sight`, `structure` and `features` (kornia);
`displacement` and the map's `register` (small_gicp); and `odometry`, the
body's pose as one factor graph over the inner ear and the depth looks
(factrs). Python waits for a system that needs it; a sketch sits in Terry's
`src/control/rhythm/pysys/`.

## Why

A cognet's job is composing parts. The mature perception, SLAM and learning
parts are C++ libraries and PyTorch models, not TypeScript (see "parts to
compose" in Terry's cognet README). Cognets are for embodied-robotics research,
whose people work in Python. So a system must be writable in Python and Rust,
and C++ must be reachable, while the cognet stays one mind: one world, one
schedule, one trace, one debugger.

The host stays TypeScript for now. The point of this design is that the host's
language stops mattering: the contract below is what every language speaks,
so the core can later be rewritten (likely in Rust) with no system changing.

## The finding: the boundary already exists

A `thread: "worker"` system already runs across a boundary
(`src/threads/`), and that boundary is a protocol, not a function call:

- **Job** (main → worker): the system's name, `now`, and the world it reads,
  as differences against what the worker already holds (`entries`, `gone`,
  `confirmed`, each keyed by component NAME and entity, with revisions).
- **Reply**: its writes (`changes`, by component name), what it read and
  queried (the trace), when it ran and for how long; or a `fault`.
- **Enforced at both ends**: undeclared reads fail on the worker (`Isolation`);
  undeclared writes are refused where the reply lands (`wire.in`).

Everything the scheduler, lineage, tracing and Fleet need is already in that
exchange, and none of it is TypeScript-specific except the encoding
(structured clone) and the values themselves. So a system in another language
is a **process that serves jobs**, speaking the same protocol in a neutral
encoding. Nothing above `Threads` learns what language a system is.

## The contract — four parts

### 1. Declaration

What a system declares, as data — the same fields `defineSystem` takes:

```json
{ "name": "control/rhythm/rhythm", "on": ["clock"], "reads": [], "recalls": ["control/pace", "control/rhythm/timing"],
  "writes": ["control/rhythm/timing", "control/rhythm", "control/rhythm/retinaBeat"], "thread": "process", "async": false }
```

The build discovers `*.system.py` and `*.system.rs` (beside `*.system.ts`),
and asks each language for its declarations once: `python -m cognet declare
<files>`, or a Rust crate's exported `declare()`. Names come from paths, as
now. Lineage and the schedule check run over the union, so a Python system
writing what a TypeScript system writes is refused at build, as today.

### 2. Component schemas — native source, protobuf intermediate

A cognet may define components in `types/**/*.components.ts`,
`types/**/*.components.rs`, or `types/**/*.components.py`. Each file may define
several. An exported TypeScript interface or type alias, public Rust struct,
or top-level Python annotated class is a component; unexported/private types
are local value shapes. A component name is its folder and its type name with
the first letter lowered. The same name in two files, even across languages,
fails at `axon prepare`.

```typescript
// types/world/places.components.ts
export interface Target { frame: string; x: number; y: number }
export interface Route { frame: string; waypoints: Target[] }
```

```python
# types/sense/detection.components.py
class Detection:
    frame: str
    x: float
    confidence: float
```

```rust
// types/motor/pose.components.rs
pub struct Pose { pub frame: String, pub x: f64, pub confidence: f32 }
```

The source declarations are read, never executed. `axon prepare` compiles
them through protobuf and generates TypeScript, Rust and Python types and
handles into the agent frame. Systems import those generated counterparts.
The native readers accept object fields, scalar and map aliases, lists, fixed
tuples, optional/nullable fields and named value references. Unsupported
syntax fails at prepare. String unions and Rust/Python enums still belong in
the older schema form until their native readers can preserve enum identity.
The generated `.agent/cognet/.schema-lock.json` holds protobuf field numbers and
reserves removed fields between prepares in the same agent frame. A field's wire
type cannot change silently while that frame is retained. A fresh frame has no
schema history, so persistent wire compatibility still needs a source-controlled
identity mechanism. A sparse
`.agent/cognet/.component-policy.json` holds runtime exceptions by full component
name, for example `{ "world/target": { "public": true } }`. It accepts
`public`, `open`, `probe` and `resident`; visual hints do not belong here.

Existing `@package` TypeScript declarations, including Terry's renamed
`*.components.ts` files with `Component<Value, Options>` containers, and older
`.proto` schemas still compile during migration. Terry's component files no
longer need `@field` or `@components`; their fields are numbered in declaration
order. Native `*.components.*` files use exported types directly.
New TypeScript component files can import value types from those schemas; an
explicit named import resolves an otherwise ambiguous type name.
The runtime's intermediate options remain in `proto/cognet/cognet.proto`.

Conventions the generators keep in every language:

- A component is named, as before, by its folder and its field's JSON name
  (`retina_beat` in `control/rhythm/` → `control/rhythm/retinaBeat`).
- An enum's values are text: the name less the enum's prefix, in lowerCamel
  (`BEAT_NAME_RETINA` → `"retina"`), or its `(cognet.text)`; `*_UNSPECIFIED`
  is not a value.
- `repeated double x = 1 [(cognet.fixed) = 3]` is a tuple, `[number, number,
  number]` / `[f64; 3]`. A map with `(cognet.keys) = "BeatName"` is a record
  keyed by that enum, any slot absent. Only `optional` fields may be absent.
- 64-bit integers are refused: values cross as JSON, where a number is a double.

`axon prepare` compiles the generated protobuf with `buf` and generates into
the AGENT'S frame, never the source: `types/control/control.ts` →
`.agent/cognet/schema/control/control.ts` (its `component()`/`frame()`
handles, which need the runtime) and `control.types.ts` (its types, plain
data, importable from pure code). Source imports them as
`#schema/control/control` and `#schema/control/control.types`; the agent's
cognet tsconfig maps `#schema/*` for the editor, tsc and bun test, and the
bundle resolves it. Discovery and `CognetComponents` name the generated
handles from the path they mirror, so names are unchanged. Nothing generated
is committed or published: an installed cognet's schemas compile into the
agent that installs it. The generator is
`platform/src/build/blueprint/cognet/schema/`.

A repeated number marked `(cognet.array)` is a BLOCK — `Float64Array`,
`Float32Array`, `Int32Array`, `Uint32Array` (`bytes` is always `Uint8Array`)
in TypeScript, `cognet::Array<T>` in Rust: what a picture, a cloud or a map
is held as. One table (`schema/arrays.ts`) maps each number type for both
emitters. A block crosses to a native system as memory, never number by
number (part 3).

Not yet: a block's SHAPE (rows × cols) in the schema, blocks in shared memory
across processes, queries in schemas, the descriptor set in the session log
for Fleet.

### 3. The run protocol

In-process (Rust, through napi-rs), a run crosses as JSON and blocks: its
declared reads and recalls as `{ now, entities, entries }` JSON, every typed
array in them lifted out — its bytes beside the JSON, `{"$array": i}` in its
place — and its writes back the same way (`src/native.ts`'s `blocks`, the
crate's `Snapshot`/`Ran`). Rust reads each value into its generated serde type
only when the system asks for it; a block is one copy of memory however many
numbers it holds. JSON was measured against napi's own value conversion and
won: a typed array cannot pass through napi's serde, and JSON keeps the
boundary bytes — the same shape a process transport will carry. A NaN outside
a block crosses as JSON's null and is refused, naming the component.

Across processes (Python, later) the same exchange goes over a Unix socket,
blocks in shared memory. Structured clone stays for TypeScript workers.

Ordering, revisions and the single-writer rule are the scheduler's, as now:
a component has one writer, so a process never races another.

### 4. Trace and faults

The Reply IS the trace: reads, queries, timing, fault. Each language's
library must observe reads the way `Isolation` does, and turn anything raised
(a Python exception, a Rust `Err` or panic) into a `Fault` with its own stack.
A fault becomes `cognet:system:failed` like any other. A process that dies is
a fault of every job it held, and is restarted; never a silent gap.

## Transports, one contract

| Where it runs | How | When |
|---|---|---|
| main thread | in-process call | TypeScript, today |
| worker thread | Job/Reply, structured clone | TypeScript `thread: "worker"`, today |
| **native, in-process** | Job/Reply as bytes through a C ABI (`declare()`, `run(job) → reply`), loaded via napi-rs on a worker; buffers as views of shared memory | Rust (and C++ through it) — next |
| process | line-delimited JSON over stdio; typed arrays as base64 blocks | Python, today |

The C ABI is two functions over the same bytes, so C++ needs no SDK of its
own: a header and the encoding. Rust gets a crate (`#[system]`, generated
handles, serde codecs) on top of it.

## Rust systems — the design (slice 2)

A Rust system is an ordinary system to everything outside it: the schedule,
lineage, Fleet and `axonl debug` see the same declaration and the same run
records.

- **Authored** as `*.system.rs` beside the TypeScript, with a
  `cognet/Cargo.toml` package for crates (`[dependencies]`; commit its `Cargo.lock`).
  `#[system(on = [...], reads = [...], recalls = [...], writes = [...], thread = "worker")]`
  on one `fn(run: &mut Run) -> Result<(), Fault>`.
- **Types** generated from the same schemas into a `schema` module: structs
  with serde, `fixed` → `[f64; N]`, enums with serde names = their text,
  `optional` → `Option`, unions → `#[serde(tag = "kind")]`, handles → typed
  `Component<T>` constants.
- **Built** by `axon prepare`: generated source and a native module in the
  agent root's `.agent/cognet/native/` — `systems` (`cognet_systems`: every `.rs` of the
  cognet mounted at the path it sits at, as TypeScript is imported —
  `library/align/align.rs` is `crate::library::align::align`, a sibling `super::x` —
  and the schemas at `crate::schema`; what `cargo test` runs) and `module`
  (`cognet_native`, the napi boundary) — built by `cargo` into one
  content-named `.node` per cognet, copied into the agent frame. A cognet with Rust systems and no `cargo`
  fails at prepare, by name.
- **Declared** by the compiled module: `#[system]` generates `declare()`; the
  build reads the declarations from the `.node` and lineage checks them with
  the TypeScript systems'. The generated entry wraps each as an ordinary
  `System` whose `run` calls into the module.
- **Run** in-process, on the main thread or a worker as declared: the wrapper
  hands Rust an owned snapshot of what it declared, and turns its writes into
  `ecs.set` inside the run's isolation — so undeclared access is impossible by
  construction and refused where it lands.
- **Faults**: the wrapper runs under `catch_unwind`; an `Err(Fault)` or a
  panic is `cognet:system:failed` with Rust's message. A segfault in wrapped
  C++ takes the process down — the cost of in-process, and what a process
  transport is for.
- **Where it lives**: the runtime crates are `cognet/rust/` (`cognet`,
  `cognet-macros`), shipped in `@arcforge/cognet`; the build is
  `platform/src/build/blueprint/cognet/native/`; the runtime's side is
  `src/native.ts`, which `Discovered` calls.
- **Measured** (2026-10-05): a small record crosses each way in ~6µs a call.
  `displacement` (an 80×45 depth look laid on the last, 12 ICP steps): the
  TypeScript ~12–15ms a look, the whole Rust call ~3.0ms — ~0.3ms JSON out,
  ~0.6ms reading the snapshot, ~2ms the ICP itself. A panic unwinding into
  JavaScript aborts the process outright — which is why `serve` catches it in
  Rust.
- **Exactness**: a ported system gives the TypeScript's doubles, so the
  replay can score the port and not a new algorithm: `Math.hypot` is JSC's
  (scaled, summed in order — not Kahan), `Math.round` rounds halves up. The
  replay alone cannot prove it — pose scores did not move for differences in
  the last digit — so a port is checked value for value against the old code.
- **C++ parts** (2026-10-06): a library that is not a Rust crate is bound
  once in `libs/parts/` — a crate with a C ABI wrapper, its sources fetched
  at pinned versions and checked by sha256 into a machine cache — and a
  cognet lists it by path. small_gicp is the first: Terry's displacement and
  map registration, scored by the replay (world ATE 3.1 → 0.3 over our own
  ICP and hill-climb). A cognet's relative `path` dependencies are resolved
  against the cognet; dependencies build optimised even in a test build.
- **Next**: the depth `Field`'s `values` as a block (half the remaining
  boundary cost is 7,200 numbers as JSON).

## Which languages

- **Rust** first (decided 2026-10-05): native speed, and C++ libraries wrapped
  (`cxx`) — small_gicp, GTSAM, OpenVINS reach the cognet this way. In-process,
  so a panic in it, or in C++ under it, takes the mind down: acceptable for
  research; isolation is the process transport.
- **Python** for systems that need its ecosystem: one persistent process per cognet,
  `@system` declarations and the same scheduler/lineage as TypeScript and Rust.
  `pyproject.toml` plus `uv.lock` pins third-party dependencies when present.
- **C++** through the C ABI only. No third SDK.

No language beyond these until a real system needs one.

## What changes in the runtime

| Piece | Where | State |
|---|---|---|
| Component schemas (TypeScript source, protobuf intermediate) | `proto/cognet/cognet.proto`, `platform/src/build/blueprint/cognet/schema/` | **built** — Terry's `types/` |
| Port the rest of Terry's hand-written shared-memory components | Terry | later |
| Rust crate: generated structs, `#[system]`, `Run`, isolation, faults | `rust/` | **built** |
| Discovery of `*.system.rs`; a generated crate registering them; `declare()` into lineage | `platform/.../cognet/native/`, `src/discovered.ts` | **built** |
| The native transport: a napi-rs module, on the main thread and every worker; JSON and blocks | `src/native.ts`, `rust/cognet/src/run.rs` | **built** |
| Blocks in schemas (`(cognet.array)`) | `proto/cognet/cognet.proto`, `schema/arrays.ts` | **built** |
| Block shapes; blocks in shared memory; binary telemetry for them | `src/ecs`, `src/threads`, Fleet | after |
| Python: `@system`, generated schema models and editor stubs, stdio process, `uv` packaging | `python/`, `src/python.ts`, `platform/.../cognet/python/` | **built** |

Fleet, `axonl debug`, lineage and the scheduler do not change: they read
declarations and run records, which are the same whatever served the job.

## Costs, taken knowingly

- A process hop each run: tens to hundreds of microseconds plus encoding.
  Nothing for a 10–20Hz perception system; wrong for a system that runs on
  thousands of tiny components every tick.
- Replay determinism weakens where a GPU model runs: replays are scored
  within tolerances, not demanded identical.
- Deploys that carry a Python environment (and CUDA) are heavier; the cheap
  `axon deploy` path stays for TypeScript-only cognets.
- Each language's library must keep up with the protocol. A mismatch fails
  at the first job, loudly.

## Decided

1. **TypeScript is the authored schema; protobuf is the intermediate.** The
   source is restricted to shapes the compiler can preserve in TypeScript,
   Rust and protobuf. Field numbers stay explicit. `buf` validates the
   intermediate, and descriptors retain component and frame metadata.
2. **Rust before Python.** The first real Rust system: `displacement`, our
   own ICP ported exactly, then replaced by small_gicp once the replay scored
   it better.
3. **Values cross as JSON, arrays as blocks** (see part 3).

## Open

- **Process isolation per system** — Python currently shares one process per cognet.
- **Queries in schemas** — a message whose fields name components.
- **Direct C++ systems** — the structure sketch below explores a typed C++
  authoring layer over Job/Reply. The current decision remains C++ parts through
  Rust; a direct system would require C++ discovery, generated schema types,
  fault handling, and its own adapter.

## Sketch

`rhythm`, in Terry:

- Rust (live): `src/control/rhythm/rhythm.system.rs`, `rhythm.rs`
- Python (a sketch): `src/sense/L0-measure/visual/structure/structure.system.py.sketch.md`
- C++ (a sketch): `src/sense/L0-measure/visual/structure/structure.system.cpp.sketch.md`
