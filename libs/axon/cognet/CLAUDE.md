# @arcforge/cognet — The Cognet Runtime

## What This Is

Everything that executes **inside** a compiled brain. Public, published, and
installed into every agent — the generated entry imports it by bare specifier,
so the bundler resolves it from the agent's own node_modules.

The counterpart is `@arcforge/core`, which **loads** brains and stays private. The
dividing question for any file: *does this run inside the brain, or does it load
the brain?*

Extracted from `core/src/cognet/` once cognets became publishable registry
artifacts. Before that, `bundle.ts` imported the host by an absolute path into
core's source tree — which resolved only in this workspace, so a published CLI
(8 files, no source) could never have compiled a cognet at all.

## The Design

**Root export is minimal.** `CognetHost` and `defineCognet`, plus `Clock`. A
cognet cannot exist without the host; everything else is opt-in via subpath, so
a control loop that never queries an entity bundles no entity store.

```
.          CognetHost, Discovered, defineCognet, Clock   — always needed
./ecs      handles (component, query, frame), the world   — opt-in
./schedule defineSystem, Schedule, Lineage                — systems
```

**A brain is systems, found wherever they sit.** Any `*.system.ts` under the
cognet default-exports `defineSystem({ reads, streams, recalls, writes, on,
once, thread, lag, run })`. The compile step discovers them, names every `component<T>()` and
`query({...})` from the folder that defines it (`L0/vision/components.ts`
exporting `flow` → `L0/vision/flow`, scoped to `L0/vision`), and the generated
entry hands the host `Discovered({ definitions, systems })`. `main.ts` and
`loop()` are for a mind with NO systems — the host ticks it once a turn of the
loop. A mind with systems is its systems: its schedule owns its ticks, so a
`loop()` beside them is refused at load (it would run once per wake, in no
tick of its own). With no loop, a wake is exactly one tick.

**Components are declared in schemas, in no language.** A cognet's `.proto`
files declare its types, components and frames; `axon prepare` generates
them into the agent frame's `cognet/schema/` — `#schema/x` (the `component()` /
`frame()` handles) and `#schema/x.types` (types, plain data) — which discovery
names from the path they mirror, like any hand-written file. The options a schema can use are `proto/cognet/cognet.proto`. A
hand-written `component<T>()` still works — that is how a cognet migrates —
but the schema is the source of truth: it is what Rust and Python systems
will be generated from. See `LANGUAGES.md`.

**A system can be Rust.** A `*.system.rs` beside the TypeScript, against the
`cognet` crate (`rust/`): `#[system(on, reads, recalls, writes, thread)]` on one
`fn(&mut Run) -> Result<(), Fault>`, its types generated from the schemas.
Every `.rs` file is mounted at the path it sits at (`crate::library::align::align`),
so Rust shares code the way TypeScript does. `axon prepare` compiles them into
a single `.node` beside the bundle; `Discovered` (via `Native`) makes each
system an ordinary one that hands Rust an owned snapshot of what it declared
and lands its changes through `ecs`, so the schedule, enforcement and run
records never learn it is native. The snapshot crosses as JSON with every
typed array lifted out as a block of bytes (`{"$array": i}` in its place) —
a schema field marked `(cognet.array)` is a typed array in TypeScript and
`cognet::Array<T>` in Rust. See `LANGUAGES.md`.

**A system runs when what runs it has changed.** A continuous mind declares
`mode: { kind: "continuous", hz }` and the host's `Pulse` drives
`kernel.wake()` at it from boot to unload — the heartbeat. Every tick, a
system runs only if what runs it changed since it last ran, by any system but
itself: what it `reads` (a new stimulus for it counts), or — when it names
them — its `on`. At most once a tick; never when nothing did, which costs the
tick one comparison. `on: [clock]` runs it every tick, for what must notice
time pass (a silence, a fade) when nothing it reads has changed. Recalls never
run anything.

The schedule has no rates and no opinion on pace. That is the mind's: one
that wants depth ten times a second writes the component depth is `on` ten
times a second (Terry's `control/rhythm` beats). `rate` was removed
(2026-10-05) because a rate on the declaration put a cognitive choice — how
often to look — in the runtime, where the mind could not change it.

Lineage refuses what would silently never run: a trigger nothing writes, `on:
[]`, a system that reads nothing and names nothing in `on` (it would run once;
say `once: true` or `on: [clock]`), and — in a mind with no clock, whose wake
ticks until its async work settles — an async system the clock restarts every
tick. A trigger orders like a read: its writer runs first.

**Input is declared and buffered.** `stimuli` is a framework input handle: a
system that names it in `reads` receives every stimulus since IT last ran
(one cursor per reader), so a slow system misses nothing — and a reader
paced by its `on` holds everything that arrives until it next runs. Undeclared, reading
it throws. It is never written into the ECS — the session log already holds
every stimulus.

**Order is derived, never declared.** `Schedule` runs writers before readers
(Kahn's algorithm, ties by name, so discovery order cannot matter); `recalls`
read last tick's value and add no edge. Before the first run `Lineage.check()`
refuses orphans, two writers of one component, and cycles — naming them all at
once. Every run is observed
and ENFORCED: touching anything undeclared fails the run, found or not, so
enforcement cannot depend on timing. Ticks COALESCE: continuous wakes overlap
by the kernel's design, so at most one tick runs and one waits, and every wake
arriving mid-tick merges into the waiting one. Its stimuli are already in the
buffer, so nothing is lost, and the backlog never exceeds one tick.

**Async systems run beside the tick.** `async run()` is detected from the
function itself — the author declares nothing. The tick does not wait: the run
gets an `Isolation` (a snapshot of its declared reads, a buffer for its
writes) routed through `AsyncLocalStorage`, so `ecs` inside it behaves as it
does anywhere. When it resolves, its buffer LANDS at the start of the next
tick, before any system runs, inside its own trace bracket. While a run is in
flight the system is not started again. A failed run fails the tick it lands
in (after the other results have landed); a run cancelled by its wake is
recorded `outcome: "interrupted"` and dropped. Its writes add no ordering
edge — landing is before every system.

**Worker systems overlap without changing the result.** `thread: "worker"`
puts a heavy, pure system on a worker thread (`threads/`); `threads` in
cognet.config.ts sizes the pool ("auto": cores − 2, at most 4; 0 runs them
inline). A tick is a dataflow over the derived order: a system starts once
every EARLIER system it conflicts with — one writes what the other reads or
recalls (`Lineage.waits()`) — has finished. Ready systems that conflict with
nothing still running proceed at once, so the tick computes exactly what the
sequential order would. A worker's result lands inside its own trace bracket
before anything that reads it starts; brackets never interleave. On failure,
nothing new starts and results still on a worker are discarded and recorded
`interrupted`.

The worker IS the bundle: the host spawns `new Worker(import.meta.url)`, the
bundle evaluates as on the main thread — same handles, same names — and
`Serve` answers jobs through the same `Isolation` an async run gets. A worker
has no kernel and no wake signal; reaching for either throws
`COGNET_WORKER_FAILED`. Lineage refuses `async` worker systems and worker
systems reading stimuli.

A worker buys parallelism INSIDE a tick, not freedom from it: its writes land
in the tick it ran in, so the tick does not end until it has — `flow()` waits
for every worker run, needed or not. Measured on Terry (2026-10-08): odometry
at 400ms on a worker made every tick 400ms and the mind ran at about 1Hz,
which starved the senses that assumed 50ms between looks. Work longer than a
tick is lagged (below), not merely put on a worker.

What crosses is a DELTA (`Known`/`Mirror`): each worker keeps what it was
sent, keyed by the entry's (rev, write time) — which every write replaces —
so a recalled value crosses only when the world's copy is a different one.
The worker's own writes are forgotten on reply and confirmed at commit, so a
discarded result is simply resent. A worker is FREE once it replies, before
its result commits: a lagged result waits ticks to land, and a worker held
until then deadlocked a pool with more lagged systems than workers (the tick
waited on a run that waited on a worker held by a result landing after it —
found 2026-10-09, `tests/hot/threads/crowded.test.ts`). A job sent to it
meanwhile that reads one of its pending writes is sent the world's value, and
that write's commit then confirms nothing (`Known`). This relies on the ECS contract that every
change is a `set`; a value mutated in place and never re-set would go stale
on a worker. Big state a worker system mutates in place and keeps (map
tiles) should sit on a `SharedArrayBuffer`: it crosses as a reference.

**Streams: every value, not the latest.** `streams: [c]` hands a run every
value written to `c` since IT last ran — `run.since(c)`, in write order, a
reaffirming write included — where `reads` gives only the latest. For what is
written more often than its reader runs: readings integrated one by one, by a
system on a beat or lagged. `ecs/history.ts` keeps every write of a streamed
component (and only those), numbered by its own sequence — `rev` names
CHANGES, and two equal readings are still two — and `schedule/cursors.ts`
holds each reader's place and trims what every reader has taken. A stream
orders like a read and, with no `on`, runs the system like one. It crosses to
a worker in the job (`Job.streams`) and to Rust in the snapshot
(`Snapshot.streams`); asking for an undeclared stream throws, in both.
`stimuli` is the same idea for input, kept separate: stimuli are not world
state, and logging them as components would record them twice.

**Lag: longer work goes over, by declaration.** `lag: n` starts a run on a
snapshot (an `Isolation`), lets the tick and the next carry on without it, and
lands its writes at the start of the tick n later, before any system runs —
`schedule/later.ts`, which lands async runs too. COUNTED, never timed: the
landing tick is the schedule's own count plus n, so a lagged run computes the
same live and replayed on any machine. One still going when its tick comes is
waited for and recorded (`cognet:system:overrun`, and `held` on the tick).
Its writes add no ordering edge (`Lineage` `touched.landing`); it is not
started again until it has landed; what it streams waits for it. A lagged
worker job is built from the snapshot taken at dispatch (`from`, on `ScheduleThreads.run`)
— a queued job would otherwise read the world as it stood when a worker came
free, after the systems behind it had changed it. Lineage refuses a lag that is
not a whole number of ticks, on an `async` system, or in a mind with no clock
(whose ticks exist only to land its work, so a lagged system written to every
tick would keep its wake ticking forever).

**The schedule owns the tick.** It opens each one through `trace.tick`
(`Clock.runTick`), so the tick number is the schedule's: merged wakes are one
tick, numbered once, and every write in it carries that number. Until
2026-10-09 the HOST opened a tick per wake, and a tick answering twelve merged
wakes was numbered twelve times, its writes stamped with whichever was newest.
`cognet:tick:start` carries what the tick answered — `now`, `wakes`, and the
stimuli it `admitted`, by their place in the mind's own stream (a confined
agent's seqs are re-stamped by the supervisor, so a seq names a different
event in the log) — and `:complete` what it was `held` by: enough to
run a session again as it ran. A replay doing so names where each async run
lands (`CognetWake.lands`), since an async run lands by timing.

**The wake outlives its ticks until its async work settles.** The kernel
resolves an engine call's run and cancellation from the wake that started it,
and a released wake's signal is never aborted — so a run outliving its wake
would be uninterruptible. The TICK never waits; the WAKE does. A mind with no
clock ticks again — like every tick, running only what something changed —
until nothing is in flight — "returns when
quiescent". `maxTicksPerWake` counts ticks of THIS wake.

**A component is just its type.** There is no visibility, no `open`, no
`probe`, no `resident` (removed 2026-10-13): any system may declare any
component, and every component is recorded. What a part of the mind offers the
rest is a convention — a folder's `export.components.*` — and every read is
declared, so `axonl debug graph` shows who reaches into whose folder. A handle
still carries its `scope` (the folder it is defined in), as information.

**Effects land with the run.** `kernel.output`, `emit` and `fault` go through
`effects.ts`: inside a SYNC run they are held, and made in order once the run
is enforced and its writes are in the world, inside its bracket — so a failed
output fails the tick instead of becoming an unawaited promise. An ASYNC run
hands back at every await, so its effects leave as they are made. A promise a
sync run leaves behind that reaches the kernel later is refused
(`COGNET_EFFECT_LATE`). The same rule holds for Rust and Python: their effects
cross back in the reply (`{ changes, effects }`), are checked against the verb
table (`verbs.ts`: effect / state / call), and are made through the same
kernel.

**Rust and Python see the kernel's state as it stood when the run began.**
`body`, `presence` and `scope` cross in the snapshot only when they change
(`States` in `native.ts`, by identity; a restarted Python process is sent them
again by its `epoch`), and the module keeps the last it was sent.

**An async Rust or Python run is a conversation.** `conversation.ts` holds
the host's side of every run in flight: it starts a `job`, answers each `call`
through the verb table (`ANSWERS` in `verbs.ts`), makes each `effect` in order,
and `cancel`s a run whose wake is cancelled; the run ends `done`, `error` or
`cancelled`. The same messages over two transports: a Python process's
stdin/stdout (`python.ts`, one asyncio loop serving every job as a task), and a
native module's `tell`/`listen` (an `async fn` system's future runs on a thread
of its own; `talk.rs` in the crate). A session's `call` and `effect` are bound
to the run's async context (`AsyncResource.bind`): a message arrives on a pipe
or a thread's callback, outside any wake, and must still reach the kernel as
the wake that started the run. A stream's every step runs in that context
too (`runs.within`): a bound function fixes only its first call.

**The run protocol is versioned and pinned.** `PROTOCOL` here, in the `cognet`
crate and in the generated module must agree, or the mind refuses to load
(`COGNET_PROTOCOL_MISMATCH`). `tests/contract/` holds the snapshot and the
reply as files; this package's tests prove the host sends and lands them, the
crate's `tests/contract.rs` proves Rust reads and writes them. `verbs.json` pins
the kernel surface and `messages.json` every message of the conversation; the
host, the crate (`SURFACE`, `tests/talk.rs`) and the Python runtime (`SURFACE`,
`python/tests/test_contract.py`, run by `tests/hot/python.test.ts`) are each
proved against them, so a verb added to the table and not implemented in a
language fails that language's tests.

**Services: a run reaches only the uses its system declares.** A cognet
declares `uses:` in its config, each naming an interface; a system declares
`uses: ["depth"]` beside its reads. The compile step joins each use to its
interface as compiled (`CognetUse`: each method's kind and parameter names)
and merges it into the host's config. Every run gets a `Gate`
(`services/gate.ts`) over the kernel's services: a use its system did not
declare is refused before the call is made, a call from a sync run is
refused (it needs an answer), and every handle the run is handed is
released when the run ends — a handle lasts no longer than the run that
made it. A TypeScript run holds `run.services` (`services/typed.ts`):
positional arguments become one object keyed by the interface's parameter
names, handles in answers get a non-enumerable `release()`. A Rust or Python
run's service calls go through the same gate (`native.ts` swaps the
kernel's `services` for it), so the rule is one rule in every language.
`release`, `reset` and `close` are EFFECTS — they need no answer;
`service.call`, `service.stream`, `service.open` and `service.push` are
calls, and `service.stream` is answered with `event`s then an `end`, or an
`answer` carrying the error that stopped it. A run that leaves a stream
early says `stop`; a Python run stops what it left open before it says
`done` (an abandoned async generator closes whenever Python likes, and a
`stop` for a finished job would break the transport). `state.services`
replaces `state.engines`: each use's `available` and `describe()`.

The grammar a cognet renders with is **not here** — it is `@arcforge/air`, a
peer package. It lived under `./air` while the reasoning was "AIR is a
cognet's choice", but the kernel parses with the same grammar, and a subpath
of this package forced ring 0 to depend on the runtime it loads. See
`packages/air/CLAUDE.md` for the input/output split that replaced it.

**The clock is not the world.** `tick`/`phase`/`system` and their telemetry live
in `clock.ts`; entities/components/watchers live in `ecs/`. They were one module
(`ecs/state.ts` owned both), which meant every cognet carried an entity store to
get `phase()`. ECS now receives a `stamp()` from the clock so world mutations are
still attributed to a tick and phase without owning the counters.

**The tick counter is the cognet's, not the wake's.** `Clock()` is built per wake
because it carries that wake's abort signal — so a counter it owned restarted at
zero every time. Invisible for an invocation cognet (one wake, many ticks);
totally wrong for a continuous one, where every wake IS one tick, so every event
a 20Hz loop emitted was stamped `tick: 1`. `Ticks()` owns the counter at host
scope and is handed to each wake's clock; the schedule advances it, a tick at a
time (see "The schedule owns the tick").

**The world's lifetime is the cognet's, for the same reason.** It was documented
as a wake-scoped working set, re-derivable from the log. That holds for a
conversation turn and breaks for a control loop: the world would be rebuilt
twenty times a second, and beliefs that exist *because* they persist — a decaying
drive, a remembered place, how long a fall has lasted — could not be represented
at all. `ecs` is built lazily on first touch, so a cognet that never queries an
entity still carries no entity store.

**A component carries WHEN it was written.** Age is part of a belief's meaning:
"position, 50ms old" and "map of the cave, 40s old" are different epistemic
objects, and anything choosing between them has to tell them apart. The store
holds `{ data, at }` and `component.writtenAt()` reads it; the clock is injected
(`EcsOpts.now`) so staleness is deterministic in a test. The time advances on an
unchanged write too — a belief reaffirmed just now is current, not merely
unaltered, and only bumping it on change would make an unchanging belief look
steadily more doubtful the longer it stayed true.

**`ComponentDescriptor.workspace` marks the pool a mind may attend to.** The
world is everything a cognet stores, most of it machinery — raw sense vectors,
efference copies. The workspace is the subset worth a thought. It is a property
of the component TYPE, not of an instance: choosing between a hundred remembered
places is attention's job, and attention selects *from* this pool rather than
defining it. Declared rather than inferred from whatever an attention system
queries, because that puts the boundary in code — add a belief, forget to update
attention, and it silently never reaches cognition.

**Component writes carry their value and are gated at the write.** A write whose
value is structurally equal to the stored one emits nothing; the store still
updates and watchers still fire. That keeps the log a record of what *changed* in
the mind rather than a stream of identical snapshots, which is what makes it
affordable for this family to carry data at all — and carrying data is what makes
the world reconstructible rather than merely auditable. How a component renders
is declared once, from its handle's `display`, by the schedule's first run —
not repeated on every write.

**A heavy value is recorded as a digest.** A value whose arrays add up to more
than 4 KiB (`HEAVY` in `ecs/component.ts`) — a decoded frame, a map — is held
and versioned like any other, recorded with each array replaced by `{ $digest:
{ kind, length } }`, and skips the equality gate (comparing it element by
element would cost more than the write). This replaced `resident`, which an
author had to remember: forgetting it logged 57KB a frame.

**A frame is a handle, not a call.** `export const world = frame({ kind:
"metric2d" })` is named from its folder like a component, and the schedule
declares every named frame (parents first) on its first run, before the
components. A component's `display.frame` and a frame's `relativeTo` hold the
HANDLE, resolved to its name at the schema — so a display cannot point at a
frame nobody declared. It replaced `ecs.frame(name, …)`, which a mind could
only call from a `once` system that read and wrote nothing: a declaration
dressed as work, and a string any typo would silently orphan.

**Importing `./host` installs the ambient globals** — `loop`, `kernel`, `phase`,
`system`, `ecs`, `defineCognet`, `definePlugin`, `defineSystem`, `component`,
`query`, `frame`. That side effect is why the generated entry imports it first, before
anything else evaluates. `definePlugin` is global-only: it registers lifecycle
hooks when called, so exporting it would invite calling it outside a brain.

**`Discovered` is the compatibility gate.** `CognetHost(config, main)` stays two
arguments because bundles inline whichever host is installed. Systems travel in
`config.systems`, and the generated entry imports `Discovered` by name only when
there are systems — so a new CLI against an old host fails at build instead of
shipping a brain whose systems never run.

**A cognet learns nothing about its environment.** No blueprint, no config, no
paths. The `blueprint` ambient global was removed deliberately — a mind that
never knew what kind of world it was in doesn't need porting when the world
changes.

## Key Interfaces

```ts
CognetHost(config, main)        // config (+ systems) + wrapped main → the definition the kernel loads
Discovered({ definitions, systems }) // names handles and systems from their paths — generated entry only
defineCognet(config)            // what the brain declares, in cognet.config.ts
defineSystem(spec)              // the default export of every *.system.ts
component<T>(opts) / query(shape, opts) / frame(descriptor) // handles; named by the compile step
Schedule({ ecs, systems, emit, trace, threads }) // derived order, checks, enforcement, one tick at a time
Ticks()                         // the cognet-lifetime tick counter
Clock({ emit, signal, ticks })  // runTick / runPhase / runSystem + the phase counter
Ecs({ emit, stamp })            // entity / component / query / one / watch / observe — all by handle
```

The ABI itself (`KernelAbi`, `CognetConfig`, `CognetDefinition`) lives in
`@arcforge/types` — types are the contract, this package is the runtime.

## Versioning

Published in lockstep with `@arcforge/types`, `@arcforge/err`, and
`@arcforge/engines` by `apps/tui/scripts/release.ts`. The version is the cognet
bundle's cache key: a compile is invalidated by the cognet's own source or by a
runtime version bump, and by nothing else.

## Known Debt

- ECS telemetry volume, MEASURED on Terry at 20Hz (2026-09-30): ~300KB/s,
  most of it three bracket events per system per tick. Now ONE
  `cognet:system:run` record per run, carrying its reads; the link batches
  commits, and kernel telemetry goes to the session's binary telemetry ring
  (`packages/session/src/telemetry/`), numbers as raw blocks. Still ~900KB/s
  on Terry (2026-10-06), half of it one depth grid logged per look until
  `range` was made resident: a big component that is not resident is logged
  whole on every change.
- Worker jobs carry the full entity list each time. Cheap at Terry's scale;
  a cognet with thousands of entities wants it delta'd like components.
- Each worker loads the whole bundle, external native deps included (sharp,
  for Terry's tiles) — memory per worker, not per system.
- No tests for `host.ts` beyond lifecycle basics; coverage is strongest on ECS.
  AIR's own suite moved with it to `packages/air/tests` (148).
