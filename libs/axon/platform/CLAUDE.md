# @arcforge/platform

## What This Is

The headless Axon developer platform. Everything the TUI, the CLI and the Fleet
extension do to projects and agents on this machine, with no terminal, no
reactivity and no prompts of its own.

`Platform()` is the composition root — one object holding every tool a runtime
needs. Consumers get it and descend; they never construct its internals.

## The Design

**Three stages, one direction.** Under `build/`, the pipeline is literal:

```
frame/       where generated output lives — the layout, and nothing else
blueprint/   scan a directory  →  a complete AxonPartialBlueprint
project/     a handle on that directory — what a user does to it
runtime/     boot it — every agent running on this machine
```

Nothing flows backwards. `runtime` uses `blueprint` and `project`; `project`
uses `blueprint`; `blueprint` uses only `frame`; `frame` imports nothing. That
last rule is what lets it sit under both — the tool scanner caches into a
frame, and almost everything else writes into one, so the layout has to be
reachable from either side without them reaching for each other.

**A frame has rooms, and they mean something.** Every project kind keeps its
generated output in one dotted directory, grouped by what the contents ARE:

```
.agent/
  types/    generated .d.ts + tsconfigs      regenerable
  cache/    tool caches, module lock         regenerable, disposable
  build/    Dockerfile, image.json, tarball  regenerable
  cognet/   the compiled brain               regenerable, PINNED (wire contract)
  data/     sessions, state, sensory         NOT regenerable — user history
```

Everything except `data/` can be deleted and rebuilt, which is what makes
`frame/migrate.ts` safe to write as delete-and-regenerate for the rest.
`data/knowledge` stays OUTSIDE the frame at the project root, because it is
authored and committed: inside the frame is what the system produced, outside
is what a person wrote. `cognet/` cannot move — `bundle/agent.ts` writes
`.agent/cognet/cognet.mjs` into the shipped manifest and deployed containers
resolve it.

**A blueprint is complete or it is not.** `Blueprint.load({ compile: true })`
compiles the agent's brain before scanning, because the scan reads the manifest
compilation writes. Two verbs with a mandatory order are one verb — three
callers used to sequence them by hand, and forgetting meant a silently stale
brain.

**Weights are acquired, never interpreted.** `project/models/` fetches what a cognet
declares in `models:`, verifies it, and caches it content-addressed in
`~/.axon/models/<sha256>/` — machine-wide, so ten agents share one copy of a 150MB
model. It knows nothing about ML: a weight is a file with a hash and a name the cognet
chose. The runtime that executes it is an ordinary npm dependency the cognet imports,
which is why there is no unified `runModel()` here — every model has its own tensor
signature, so acquisition collapses to one mechanism and inference cannot.

**README assets are a SEPARATE artifact from source.tar.gz.**
`project/bundle/assets.ts` validates and compresses a project's `assets/` folder
into its own `assets.tar.gz`, uploaded as its own publish part and unpacked
server-side to a per-version prefix the backend serves. An author writes
`./assets/shot.png` in their README and that one string is correct in the repo,
on GitHub, and on the site — the alternative (rewriting links at publish time)
makes the stored README disagree with the file on disk. This replaced README
images hosted on Discord CDN links, which carry an expiry signature: a permanent
document pointing at a temporary URL.

**The separation is the load-bearing part.** The first version shipped assets
INSIDE source.tar.gz, reasoning that an asset is a source file the author
committed — true about provenance, irrelevant to distribution. Measured on
@axon/ember-theme: 60,272 of 60,844 bytes (99%) of the install payload was
screenshots for 5KB of code, downloaded by every `axon install` and every
transitive resolution, and read by nobody (the site serves the unpacked
per-version objects, never the tarball copy). After separating, that artifact's
`source.tar.gz` is 2.3KB against a 54KB asset archive the website alone fetches.
A 10MB demo video for a 100KB extension is the case that makes it obvious.
`tests/unit/project/assets-tarball.test.ts` asserts `source.tar.gz` has no
`assets/` member, which is what keeps it that way.

It is a LEAF, not a row in the kind table, because assets are not a per-kind
difference — **every publishable kind gets them on identical terms** — and
because an asset is validated, re-encoded and budgeted rather than merely copied.

**All three bundlers call it.** `Assets()` was wired into `source` alone at first,
so an agent with a demo mp4 in `assets/` published with no assets at all: the CLI
said nothing, the tarball was valid, and the registry page rendered an empty video
player. The author's only signal was a broken page. `agent.ts` and `module.ts`
now collect too — and `KINDS` maps seven kinds onto these three bundlers, so
covering the three covers every kind. `assets-tarball.test.ts` asserts the module
path explicitly, because that is the omission the type system could not catch.

The agent bundler is the one that clears NARROWLY: `.agent/build` holds the cognet
compile cache, so it names `assets.tar.gz` and `.assets` rather than wiping its
outputs the way the other two do.
Four rules it enforces, each because the published version is immutable:

- **Compression never renames a file.** An image is re-encoded in its OWN format
  (PNG→PNG, JPEG→JPEG), because a README references `./assets/shot.png` literally
  and the site resolves that exact path — converting to WebP and renaming 404'd
  every compressed image. It is also *better* on real content: `palette: true` on
  a flat-colour terminal screenshot beat lossy WebP 13KB to 29KB from a 34KB
  source. Lossy WebP only wins on photographs, which a README rarely holds.
- **sharp is imported lazily**, inside the compress call — the Fleet extension
  host imports this module tree and must not load a native binary for a path it
  never runs.
- **Video is size-checked, never transcoded.** ffmpeg is not a dependency
  `axon publish` can assume, and compressing only when present would mean the
  same input publishes different bytes depending on who ran it.
- **SVG is refused outright** — an executable document served from our own origin
  is stored XSS.

Compressed assets are staged at `<bundleDir>/.assets/assets/…` and tarred from
`.assets` with the entry `assets`, so every member is named `assets/<path>` — no
npm `package/` prefix, because nothing installs this archive. The staging tree is
removed once packaged; left behind it is a stale duplicate of every asset after
the author's next edit.

**Assert on the artifact, not the report.** An earlier bug shipped a tarball with
NO assets while the CLI printed a compression report for four images and the
website rendered alt text — and it survived a full unit suite for `Assets()`,
because every test checked the returned report and none opened an archive. A
report is a claim about an artifact and cannot stand in for it.
`tests/unit/project/assets-tarball.test.ts` exists to close that gap and is where
any new assertion about what ships belongs.

**One gate decides whether a project's dependencies are sound.** `tree.verify()`
compares what the manifest declares against what is on disk and returns typed
`Fault`s — `missing`, `stale`, `dangling`, `foreign`, `registry`, `shadowed`.

It exists because every dependency incident this system has had was the same
shape: state on disk disagreeing with the manifest, with nothing checking before
trusting it. Each got its own repair bolted to the front of `prepare` — four of
them, four places to remember. A fifth class is now a new `Fault` variant instead.

Two rules make it work:

- **It detects, never repairs.** `--frozen` has to ask this exact question and
  refuse; a check that fixes what it finds can never fail. Callers decide.
- **`reconcile` kept the MANIFEST half** (prune, write ranges) and verify took the
  DISK half. Two implementations of "is the tree right" is how they drift apart.

Verification runs BEFORE the installs, which is the ordering the pipeline
previously had backwards — bun resolves the whole manifest at once, so one
unresolvable range fails every package with it, dying long before the repair
that would have fixed it. `axon doctor` is the same primitive with repair
switched off.

**Two registries, one project directory.** A machine that talks to both
production and local staging shares one `package.json`, one `bun.lock` and one
`bunfig.toml` between them, and all three can end up describing the other one:

- a RANGE auto-resolved against staging names a version production never had —
  `axon.trackedFrom` records which registry wrote each range, so a foreign one
  is re-resolved instead of honoured into a permanent failure
- `bunfig.toml` maps scope → registry, and `ensure()` used to return the moment
  a scope existed WITHOUT checking its URL — so a project kept fetching tarballs
  from whichever registry was configured first, while ranges resolved against
  the current one. It corrects the URL now.
- `bun.lock` pins fully-qualified tarball URLs, so it is discarded on a registry
  switch: replaying it would re-fetch everything from the old registry no matter
  what bunfig says.

The tree cache is keyed on `bunfig.toml` among other inputs, so staging and
production never share a resolved tree to begin with.

**The resolved-tree cache is shared machine-wide, and eviction respects
referrers.** `treecache.ts` stores one tree per unique (dependencies, registry,
lockfile) triple under `~/.axon/cache/trees`, and a project's `node_modules` is
grafted onto it as symlinks rather than copied — ~1ms instead of ~370ms per
install. LRU eviction skips any tree a live project still points at: deleting one
does not cost a reinstall, it leaves that project's node_modules full of dangling
links which every resolver reports as "package not installed". Referrers are
verified rather than trusted, so a deleted project cannot pin an entry forever.
Its root is injectable specifically so tests can exercise eviction without
touching a developer's real cache.

**TypeScript will not emit declarations inside `node_modules`, and the tool
scanner has to.** An installed Axon module ships TypeScript SOURCE that the
consumer's scanner declares to build the tool scope — but tsc treats anything
under `node_modules` as external library code and silently skips declaration
emit for it. A tool file importing a sibling therefore got one `.d.ts` where it
needed two, every type declared in that sibling became unresolvable, and the
error blamed the author for a missing re-export their source already had.
@axon/arxiv shipped twice that way and failed on every install.

`declare.ts` compiles through a SHADOWED path (`/node_modules/` →
`/__axon_modules__/`), rewriting only the segment tsc keys its decision on.
Reads follow the shadow back to the real file, `realpath` is shadowed too (it
would otherwise resolve the rewrite away), and emitted paths are mapped back so
no caller ever sees the internal name. Byte-identical files now declare
identically inside and outside node_modules — which is the property the tests
pin, because the tell was that the same source gave different answers depending
only on where it sat.

**An installed module's tools are READ, not re-derived.** `published.ts` reads
`.module/build/manifest.json` — each tool's `fns`, `ambientTypes` and bundled
`source`, all emitted at publish time in the module's own directory. That is
strictly more correct than anything derivable from the installed copy, and
costs one file read instead of a `ts.createProgram()` plus a bundle pass. It
returns null for any incomplete manifest (missing tools, missing source, a set
that disagrees with the installed files), falling back to compiling — which now
works in either location.

**Publish verification runs in the CONSUMER'S LOCATION.** `verifyArtifact`
extracts the tarball under a `node_modules/` path and calls `Tools()` — the
consumer's own entry point, not the compiler beneath it. Verifying in a plain
scratch directory is what let arxiv publish twice: same bytes, same function,
different answer, because the location is an input to the check. It also
asserts every tool file produced an entry, since a tool silently missing from
scope is worse than one that fails loudly.

**A kind is data, not control flow.** `project/kinds.ts` holds one row per
project kind (agent, module, cognet, bench, prompt, extension, profile): config
filename, tsconfig includes, bundler, visibility, scaffolder, which framework
subset it installs, whether the registry accepts it. Every per-kind decision
reads that table. If something about a kind cannot be expressed as a field,
widen the table — do not reintroduce a branch. (The frame's directory name is
derived, not stored: it is the kind's own name, dotted. `profile` is the one
exception, in `FRAME_DIRS` — a user's frame is `.axon`, because that directory
is the one place the product's name means something to them.)

**A profile is a project.** `~/.axon/profiles/<email>/` became one the moment it
gained code: `main.ts`, `plugins/`, and `extensions/` the user writes or
installs. It gets a type frame, a tsconfig, an install and a scaffolder from the
same table as everything else. What makes it unusual is only who runs it —
`platform.profile.ensure()` fires on boot for whoever is logged in, so its
scaffolder writes each file ONLY IF ABSENT. A broken profile is never replaced
(unlike zeno, which is re-cloned): it holds the user's own config, credentials
and history.

An `extension` is that same shape packaged for someone else — same globals, same
frame, same layout — so an extension can express exactly what a user's own
config can. Neither installs the agent framework: `framework: "types"` gives
them `@arcforge/types` and `@types/bun` and nothing else, because they configure
a terminal rather than run an agent.

**Loading a config is importing it.** `build/extensions/` runs the user's TUI
config. There is no build step and no `setup()` to call: `commands.register(...)`
at module scope runs as the module body evaluates, so importing a file IS
loading it — Bun transpiles `.ts` directly, cache-busted with `?t=uuid` so a
reload re-evaluates. `profile.config.ts` is read through the same
capture-a-global mechanism `blueprint/scan/config.ts` uses for
`axon.config.ts`, and reading it never runs any extension: that separation is
what lets `axon ext install` edit the list safely.

Three rules the loader exists to enforce:

- **Order is the collision policy.** Profile first (a user's own config wins),
  then extensions in `profile.config.ts` order, `main.ts` before `plugins/*`
  alphabetically. Resolution may be concurrent; loading never is.
- **Nothing throws.** Every failure lands in the returned result — a broken
  config still leaves a working terminal, which is the one the user needs in
  order to go fix it. Containment is PER FILE, and registrations made before a
  throw are kept: they are real, and removing them would surprise someone whose
  command works right up to the typo.
- **Every registration is disposable.** The API implementation (in the TUI,
  where the composables are) calls `extensions.disposers.track()` on each
  register; the loader attributes it to whichever source is loading. `reload()`
  disposes in reverse, completely, before re-importing — overlapping the two
  would leave both generations live and resolve every collision against the old
  copy.

**A brain can be inline, and then the folder is the declaration.** An agent
names its cognet three ways: a registry string, an imported config, or by
simply having `<agent>/cognet/cognet.config.ts` — no `cognet:` line at all,
the way `src/tools/` needs no `tools:` list. All three resolve to one
`CognetSource` and the rest of the pipeline cannot tell them apart, because
compilation erases the origin: the bundle ships the compiled brain, never
cognet source.

An inline cognet is part of the agent, not a project. `detectKind()` refuses
to claim it (otherwise a command run from inside it would open a package that
has no package.json), it gets no manifest of its own, and it is never
separately publishable — while the agent around it publishes normally. It does
get its own tsconfig scope in the agent's frame, because the cognet authoring
globals (`loop`, `kernel`, `phase`) and the agent's must not share one ambient
space — the same reason `tests/` has a third. Declaring both a `cognet:` line
and an inline folder is an error, not a precedence question.

**Instances are a forest.** Ten unrelated agents running side by side is the
normal case. Parentage exists so an agent-initiated spawn can be bounded
(`runtime/requests.ts`), not because nesting is the default shape.

**Services are lower-level than build.** `store` (~/.axon), `cloud`, `registry`,
`deployments`, `update`, `ollama` (local models), `test` (Bun runs projected into
events), `mic`. Every one is a leaf the build stages receive rather than reach
for.

**`bin/` is what the OS invokes.** `supervisor.ts` is the real CLI entrypoint;
`update-helper.ts` runs after the app exits; `test-preload.ts` and `test-api.ts`
are loaded into each `bun test` child. None is imported by the app — they cross
the process boundary as paths, not as modules, and share only a contract
(`services/update/contract.ts`, `services/test/frames.ts`).

## Structure

```
src/
├── platform.ts   the composition root
├── bin/          executables — supervisor, update-helper, test-preload
├── build/
│   ├── frame/      the generated-output layout + migration of older ones
│   ├── blueprint/  scan → blueprint (cognet/ compiles the brain)
│   ├── project/    manifest, modules, models, tree, bundle, typegen, prepare, publish
│   ├── extensions/ the user's TUI config: read the list, import, track disposers
│   ├── runtime/    instances, agent, requests, zeno, profile, sessions
│   └── bench/      benchmark definitions and runs
├── services/
│   ├── test/       Bun runs projected into a structured event stream
│   ├── ollama/     local models: installed, available, pull
│   └── …           store, cloud, registry, deployments, update, mic
└── utils/          fsx, tsast
```

## Key Interfaces

```typescript
const platform = Platform({ version, store?, cwd?, distribution? })

platform.projects   // find, open, create — every project kind
platform.profile    // the user's own directory: ensure() on boot
platform.extensions // the user's TUI config: load(), reload(), unload()
platform.agents     // Runtime(): spawn, attach, focus, stop, sessions, zeno
platform.cloud      // AxonCloud client + profile/credential disk wiring
platform.store      // ~/.axon
platform.registry   // clone/fork a published artifact
platform.updates    // check + hand off a self-update
platform.ollama     // local models: installed, available, pull
platform.tests      // TestRunner(): run files, stream lifecycle events
```

## Known Debt

See `debt.md`.

## Policy and Confinement (agent-process reshuffle, commits 1–2)

**`src/confine/`** is the source of truth for OS confinement — moved here from
`@arcforge/capsule`, near-verbatim. `Confinement()` composes bwrap (mount/pid/ipc/
net namespaces) and a systemd cgroup scope into the argv a box is exec'd with.
One change during the move: `ENTRYPOINT` was a module constant resolving the
capsule subprocess's own entrypoint from `import.meta.dir`; it is now
`entrypoint(candidates)` plus a required `Confinement({ entrypoint })` option.
Confinement knows how to build a box and nothing about what goes in it, which
is what lets one builder confine the capsule subprocess today and the whole
agent process after the reshuffle.

The capsule still carries a copy at `packages/capsule/platform/confine/`,
deliberately: platform depends on `@arcforge/capsule`, so the capsule cannot import
from here without a cycle. That copy dies with the capsule subprocess.

**Policy resolution is NOT here.** It lives in `@arcforge/types`
(`policy-normalize.ts` + `policy-build.ts`), because the kernel must reach it
and the dependency runs platform → core → kernel → capsule → types. `Policy()`
is the one seam where a profile ceiling and an agent's own policy become the
shape the box enforces; it replaced two implementations kept in step by a test
that compared string literals across two files' source.

**`src/procs/`** folds a session's event log into the process tree every
surface renders. Pure and source-agnostic: `capsule:proc:start/complete/failed`
are durable events, so a local runtime and an attached deployment produce the
same tree from the same fold. This replaced the TUI reaching through
`runtime.kernel.userland` into a live capsule handle — which existed only for
an agent running in that process, so a deployment's list was always empty.

## The Supervisor ↔ Agent Link (`src/link/`)

The transport carrying the six verbs in `@arcforge/types`'s `SupervisorToAgent`
/ `AgentToSupervisor`. Three layers, each testable without the one above it:

```
frame.ts     length-prefixed framing over a stream socket   pure
channel.ts   correlation, streams, aborts                   pure (loopback)
socket.ts    unix sockets, the write queue, backpressure    the only I/O
supervisor.ts / agent.ts   the two handles + RemoteDriver
```

**Framing is explicit because SOCK_SEQPACKET does not exist here.** Neither
`Bun.listen` nor `node:net` exposes it, so message boundaries are ours to keep:
a 4-byte big-endian length then the payload. That is better than the JSONL the
capsule wire uses anyway — payloads are opaque bytes, so nothing couples the
encoder to a delimiter, and the `undefined`→`null` replacer JSONL needed has
nothing left to fix.

**Two channels, because `interrupt` must not queue behind `infer`.** On one
socket it would sit behind exactly the traffic it exists to stop. The capsule
worked around that by killing and rebuilding the subprocess (`hardInterrupt`,
racing a 50ms timeout); a second socket removes the need rather than tuning it.

**The agent connects by PATH, not an inherited fd.** `Bun.spawn` exposes stdio
only, so the socket directory must exist inside the box — it is a declared bind
mount, and the one hole punched through an otherwise deny-by-default
filesystem. Worth naming as such whenever the confinement spec is read.

**`RemoteDriver` is why the credential never enters the box.** It satisfies
`AxonEngineDriver`, which is already defined as "a dumb token pipe: messages in,
raw deltas out" — which is exactly what a wire is. So the Engine() manager stays
agent-side owning AIR, retries and the stall guard, and cannot tell the tokens
crossed a process boundary. The agent names a ROLE and never sees a model, a
provider, or a key.

**Two bugs the loopback tests could not have caught**, both found by the
real-socket suite and both worth remembering:
- `socket.write()` returns bytes ACCEPTED, and goes short once the send buffer
  fills (~233KB here). Ignoring it dropped 222 of 500 messages silently, and a
  frame truncated mid-payload desynchronises the stream permanently. `Writer`
  queues the unwritten tail and flushes on `drain`.
- That queue then absorbed backpressure into memory, turning a stalled consumer
  into unbounded growth. `ChannelSocket` exposes `pending`/`whenDrained` and a
  stream producer parks above a high-water mark — backpressure that never
  reaches the producer is not backpressure, and on the real wire the producer
  is spending money.

**The agent connects by PATH, so the socket dir is a declared mount.** The
confinement spec gained a `control` field for it, kept SEPARATE from `fs.write`
rather than merged: those are the runtime's own plumbing, not a grant the user
authored, and `axon policy` must be able to render what the user allowed
without a socket directory appearing as though they had asked for it. It is the
one hole through an otherwise deny-by-default filesystem —
`tests/unit/link/confine-socket.test.ts` pins both that it exists (a confined
agent that cannot reach its supervisor fails silently) and that it stays one
directory wide.

**`AgentRuntime` adapts a live `Axon()` to the four verbs.** Every verb is one
delegation; the runtime already owns the behaviour and a second implementation
here would be somewhere for the two to disagree. The subtle one is `stimulus`,
which resolves on ADMISSION and never on completion — a continuous cognet ticks
whether or not the last wake finished, so waiting for completion would
serialise the overlap the scheduler exists to allow. `RUN_IN_PROGRESS` comes
back as `admitted: false` (the mind declining a second conversation, which is
an answer); anything else propagates, because a fault disguised as a polite
refusal is a broken agent that reads as healthy.

**`prepare()` arms the listeners BEFORE the child exists.** A child that dials
before anyone is listening gets ECONNREFUSED and dies at startup, so ordering
here is load-bearing rather than incidental — the same shape the capsule's tool
loader already uses ("listeners armed — now ask"). It resolves only once BOTH
channels have a peer: a link with only control connected can accept a stimulus
it has no way to answer.

Sockets live at `~/.axon/cache/link/<sessionId>/`, `0o700`, matching the
running records. That mode is the whole access control: a unix socket's
permissions are the only thing between this agent's supervisor and any other
local process, and the supervisor holds provider credentials — the exact asset
the boundary exists to protect. The directory is removed and recreated on
prepare, because a process killed with `-9` leaves paths that `listen` refuses
with EADDRINUSE even when nothing is behind them.

## The Confined Agent (`src/link/agent-main.ts`, `src/link/confined.ts`)

`agent-main.ts` is what the box execs — and the difference from the capsule's
`process/main.ts` is what it CONTAINS. The capsule held only model-emitted code
and tools, with the cognet and the kernel outside it. This holds the whole
agent: cognet, kernel, tools, scripts, routes and model-emitted code, one heap,
one context, bounded by one OS box. What stays outside is what must never enter
— the provider credential, the session log, the escalation decider.

`spawnConfined()` composes `prepare()` (sockets) with `Confinement()` (the
wall). Three mount classes, kept deliberately distinct:

| Mount | What it is | Why separate |
|---|---|---|
| `runtime` | the interpreter + its package | not the agent, not a grant |
| `project` | the agent's OWN code — cognet bundle, tools, node_modules | the program itself |
| `control` | the link socket directory | supervisor plumbing, not a grant |
| `fs.read/write` | what the USER granted | the only one `axon policy` should render |

`project` is what the capsule deliberately avoided: there, tool source was
BUNDLED and materialised inside the box precisely so no project file was ever
mounted. In-process the agent's own code IS the program, so it has to be
present — and naming it separately keeps "the agent's code" distinguishable
from "what the user allowed".

**The proof is `tests/integration/confined/cognet-boxed.test.ts`**, and it
asserts both directions: denied network blocks / granted network reaches;
denied path is absent / granted path reads. A wall that blocks everything is
not a policy, so every denial is paired with the grant that must still work.

Its fixture speaks the wire protocol BY HAND and imports nothing outside its
own root. The first version imported the real link modules by absolute path and
died every run with "Cannot find module" — those files are outside the box,
which is the confinement working exactly as designed. Widening the mount would
have made the test pass by weakening the thing under test.
