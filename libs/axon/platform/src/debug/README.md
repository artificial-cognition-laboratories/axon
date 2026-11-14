# axon debug

The tools an agent uses to see inside a running or recorded mind.

A person debugs with Mission Control. An agent debugs with this: a small set
of commands that answer, from a terminal, every question the debugger
answers on screen. Built for an agent first — exact, bounded, machine-read —
and usable by a person second.

This file is the specification. It is written before the code and kept
current with it.

## Why it exists

A good debugger for the person is half of the job. The agent working on the
code needs the same reach, or every change waits on a person booting the
game and describing what they see. With these commands an agent can find
the last run, see what failed, read any value at any tick, follow a value
back to its causes, and look at a frame with layers drawn over it.

## Principles

1. **One door.** Everything is under `axon debug`. Nothing is added to the
   top-level CLI.
2. **A small bag, chosen.** Each command answers one kind of question. A
   command is added when a question cannot be answered, never because the
   data happens to be there. Too many tools is the same as none.
3. **JSON out, always bounded.** One JSON object on stdout. Lists stop at a
   default limit and say so (`truncated`, `next`). No command can print a
   500 MB log by accident.
4. **Recorded and running are the same.** A running session is read from
   the same files as a finished one. Where a command cannot answer from
   them (a heavy array, recorded as a digest) it fails and says why.
5. **Read-only by default.** Only `set` and `prune` change anything, and
   `prune` does nothing without `--apply`.
6. **Never guess.** A value the record does not hold is reported as not
   recorded, not as zero or empty.

## Status

Step 1 is built: `sessions`, `session`, `graph`, `errors`, `events`, `perf`,
`resources` and `prune`. `state`, `why`, `field` and `set` are specified below and not
built. `live` as a session name is not wired; a running session's files are
read the same way, so `latest` names it.

## What is recorded

Each agent keeps its data under `<agent>/.agent/data`, in four places with
four lifetimes.

| Data | Path | Holds | Kept |
|---|---|---|---|
| Session log | `sessions/<id>.jsonl` | What the mind declared, and what happened to it | For good |
| Telemetry | `telemetry/<id>/NNNNNN.axt` | Every tick, system run and component write | A window: 1 GB |
| Sensory | `sensory/<id>/NNNNNN.jsonl` | Dense stimuli as they arrived | A window: 1 GB |
| Media | `media/<id>/` | Frames sent by reference | A window: 1 GB |

The three windows are kept for the newest three sessions only. When a
session opens, the windows of every older session are removed; their logs
stay. So `perf`, `events` and `graph` answer for a recent session, and an
older one has its log alone: what it declared, its faults and its usage.

**The log** holds the build, the schema (`cognet:component:declare`,
`cognet:frame:declare`), the graph (`cognet:schedule:declare`), stimuli and
outputs that are not dense, kernel runs, usage and errors.

The log also holds a sample of what the agent's processes used, every
couple of seconds (`axon:usage`): memory, CPU and GPU by part, and CPU by
thread. It is in the log, so `resources` covers the whole session.

**Telemetry** holds what a mind does tick by tick (`TELEMETRY_EVENTS` in
`@arcforge/types`), in a binary format of its own:

| Event | Gives |
|---|---|
| `cognet:system:run` | One record per run: tick, start, duration, outcome, thread, and **what it actually read, by revision** |
| `cognet:component:add / update / remove` | Every logged write: tick, system, entity, component, revision, value |
| `cognet:tick:*`, `cognet:phase:*` | The clock |

Every event in either place carries the session's own `seq`, so the two are
one ordered stream.

Four limits follow, and the commands state them rather than hide them:

- **Telemetry is a window.** Terry writes about 1.9 MB of it a second
  (measured 2026-10-02; half of that is one debug field, `shapes`), so
  1 GB is the last nine minutes or so. Timings, writes and causes are
  known for that stretch and not before it. `perf` and `session` say which
  stretch they cover.
- **Resident components are not recorded.** `sight`, `features`, `held` and
  the like are working state, too large to write down. They can be read on
  a live session only.
- **An async run does not record its reads.** `why` stops at an async
  system and says so.
- **A tick's time is its own.** The schedule opens and closes each tick, so
  a tick's recorded duration is start to end: its systems, the workers it
  waited for, and any lagged run it had to wait to land — not the async work
  it started, which lands later. A tick that waited records on what
  (`held`); `perf` reports that apart from the main thread's share. (A
  runtime from before 2026-10-09 timed each wake instead.)

## Addressing

```
axon debug <command> [<session>] [flags] [--agent <dir>]
```

- `--agent` is the agent's directory. Default: the current one.
- `<session>` is a session id, any prefix of one that only one session has,
  or `latest`. Default: `latest`.
- A system or component is named in full (`L0/world/map/map`) or by the end
  of its name (`map`) when only one ends that way.

Every answer is one line of JSON with the same envelope:

```json
{ "ok": true, "session": "a64951ad-…", "data": { }, "truncated": false, "next": null }
```

A failure is `{ "ok": false, "code": "AX-…", "message": "…" }` with a
non-zero exit code.

## Shaping an answer

Every command that returns rows takes the same few flags, so each composes
the same way and an answer is only as large as the question.

| Flag | Does |
|---|---|
| `--where <key><op><value>` | Keeps rows that pass. Repeat to narrow further. `=` `!=` `>` `<` `>=` `<=`, and `~` for contains |
| `--search <text>` | Keeps rows that mention it anywhere, whatever the case |
| `--sort <key>` `[--desc]` | Orders by a key |
| `--limit <n>` `[--last]` | At most n rows: the first, or the last |
| `--fields <key,key>` | Gives back only these keys of each row |

A key is a path into a row: `bytes.total`, `data.system`,
`data.value.depth`. Numbers compare as numbers. A row without the key
fails every test but `!=`.

```
axon debug sessions --sort bytes.total --desc --limit 5 --fields id,seconds,bytes.total
axon debug perf --where "p95Ms>50" --where async=false --fields system,p95Ms,maxMs
axon debug events --component entity --where "data.value.depth>0.5" --last --limit 3
axon debug events --search "no fit" --fields type,data.system,data.error.message
```

The rows of each command: `sessions` its sessions; `graph` its systems and
components; `errors` its faults and troubles; `events` its events; `perf`
its systems; `resources` its threads.

On `events`, `--where` and `--search` are applied where the events are
read, before the limit — they narrow the whole session, not the first
fifty. On `sessions`, a test, a sort or `--last` reads every session, which
takes a few seconds with hundreds of them; without one, only as many as
are asked for are read.

The shaping is presentation, and lives with the CLI
(`apps/tui/cli/commands/shape.ts`).

## The commands

### Find

**`sessions`** — the recent sessions, newest first, twenty unless told
otherwise. Each row: id, started, last written, seconds, and
bytes on disk by kind. Read from headers and the filesystem alone, so it
costs nothing however large the sessions are.

**`session`** — one session on one screen. `signs` first: everything that
says it is not well, one line each (see Signs). Then the mind (systems,
components, target rate); tick rate against target and ticks over the
deadline; faults; troubles; the five costliest systems; memory, CPU and
the busiest threads; bytes on disk by kind.
The command to run first on any report of "something is wrong".

#### Signs

`session` reads these off what the other commands measure, so one command
says whether to look further and where. `checked` lists every sign looked
for: one missing from `found` was checked and was fine.

| Sign | Raised when | Look further with |
|---|---|---|
| `faults` | Any event ending `:failed` or `:error`, or a `build:warning` (a plugin that did not load) | `errors` |
| `failing` | A system had a run that did not complete | `errors`, `events --system` |
| `slow` | Under nine tenths of the mind's own tick rate | `perf` |
| `deadline` | More than one tick in fifty held the main thread past the deadline | `perf` |
| `late` | More than one tick in fifty ran past the deadline start to end — workers and lagged runs waited on included; names the systems ticks waited on, longest first | `perf` (`held`, `heldMs`) |
| `memory` | A part's memory still rising 10 MB a minute over the later half of the session — judged only once that half spans two minutes: a shorter stretch cannot tell growth from the collector's sawtooth | `resources` |
| `saturated` | The whole machine at 90% CPU or more on average; says what the agent's parts took and which processes took the rest | `resources` |
| `inference` | Model calls' durations add up to nine tenths or more of the time they were made in: calls waiting on each other | `inference` |
| `troubles` | A trouble is still open | `errors` |
| `quiet` | A stimulus channel heard at least twenty times fell silent for twenty of its own usual gaps (and at least 10s) before the session ended: a body lost or a cable dropped while the mind ran on | `events --search <channel>` |

The limits are one table at the top of `signs.ts`.

### Structure

**`graph`** — who reads and writes what. Read from the session's own
declaration, so it works with the agent stopped and an old recording is
explained by the graph it ran with.

- No arguments: every system in run order, with rate, thread, reads,
  recalls and writes; every component with its flags.
- `--system <name>`: that system, with `--downstream` (everything its
  writes can reach) or `--upstream` (everything its reads depend on).
- `--component <name>`: its writers and its readers.
- `--depth <n>` bounds a walk (default 6). Each system is reached once, by
  the shortest way. A `recalls` edge crosses a tick, and is marked as one.

### Inspect a run

**`errors`** — everything that went wrong, in order. Faults: any event whose
type ends `:failed` or `:error`, and any system run that did not complete.
Troubles: each time a component named `trouble` was set or removed — the
convention by which a cognet reports a fault of its own.

**`events`** — the log, filtered.
`--type <prefix>`, `--system <name>`, `--component <name>`, `--entity <id>`,
`--from` / `--to` (ticks), `--from-ms` / `--to-ms`, `--after <seq>` (the
`next` of the answer before). Fifty unless told otherwise; `--last` gives
the last that match, read from the newest telemetry first. Long arrays and
strings are cut and say how long they were; `--full` gives them whole.

**`perf`** — the window it covers; ticks a second against target; each
tick's time start to end (`wall`) and how many ran past the deadline
(`late`), and its main-thread share and how many of those were over; each
system, costliest first: runs, mean, P95, worst, failures, threads, whether
it ran beside the tick, and how long ticks waited on it (`heldMs` over
`heldTicks`); and `held`, the systems ticks waited on, longest wait first.
P95 is to the edge of a bucket — an upper bound. `--system <name>` narrows.

**`resources`** — what the agent's processes used, over the whole session.
For each part (`brain`, and whatever supervises it): memory at first, now
and at most, how fast it rose after start-up and how fast over the later
half alone, and a short series of readings; CPU in cores; GPU; video
memory. `machine` is the whole machine beside them: how busy it was, and
the processes that kept it busy, the agent's or not — what says whose a
full machine is when the parts do not add up to it. Parts are `brain`,
`body` and `world` when it is in a lab, and the process supervising it
(`daemon`, or `terminal` when a command or the TUI hosts the supervisor).
Then each thread group — `main`, each `worker`, and the runtime's
own by name — with the cores it kept busy, busiest first. `--points <n>`
sets how many readings of a series come back (default 12).

**`inference`** — the calls the mind made to its models, over the whole
session. For each engine role: calls, calls a second, mean, median, p95 and
worst duration, how many failed, and `busy` — its durations added up over
the time covered. A duration runs from asking to answer, so it includes
waiting for the worker; one worker cannot be busier than 1, and a total
above that is calls waiting on each other. `behind` says it directly: of
the calls begun, how many found the worker free and how many found one,
two, three already under way.

**`state`** — the ECS at a moment.

- No component: the entities, and which components each holds.
- With a component: its value on each entity that holds it, with its
  revision and when it was written. `--entity <id>` narrows.
- `--history`: that component's values over a range, one row per write.

**`why`** — the causes of a value. From a component at a moment: the run
that wrote it, the values that run read, and the runs that wrote those —
back to the stimuli that entered the mind. `--depth <n>` (default 3).

**`field`** — a field as numbers and as a picture.
Range, mean, share of cells measured, and where it lies in its frame.
`--png <path>` writes it; `--over frame` draws it over the frame of sight
it was computed from; `--with <component>,…` adds more layers. An agent
reads the PNG to see what the person sees.

### Control

**`set`** — write a component on a live session:
`set <component> --entity <id> --value <json>`. Later, a declared setting
of a system. Refused on a recorded session. `pause`, `resume` and
`step [n]` are flags of the same command, since they are the same kind of
act: taking hold of a running mind.

**`prune`** — what the retention rule removes, and removing it.
Every session is kept whole — log, telemetry, sensory, media, its index — for
three days after it was last written, and while an agent's sessions fit in
50GB; past that, the oldest go first. A conversation (a session a person or a
job typed to) keeps its log: that is what was said. A session written to in
the last five minutes is taken to be running and is left alone. The same rule
runs on its own each time a session opens; `--older-than <days>` and
`--budget <GB>` change it for one prune. Deletes only with `--apply`.

## What is built underneath

### The graph

`graph` reads the `cognet:schedule:declare` a session recorded.

Not built: a graph compiled at `axon prepare` and written beside the
bundle, so there is one before the agent has ever run and it matches the
source as it is now. That needs the bundle loaded at prepare to collect its
systems, which is its own piece of work.

### The index

A session is too large to read for every question. Its log reaches
hundreds of megabytes and its telemetry a gigabyte.

Each session gets `<data>/debug/<id>.json`, written by the first question
and extended by later ones:

- **The log** is scanned a line at a time, never loaded. Most lines are
  read only as far as their type; faults and the declaration are parsed.
  It only grows, so the index records the bytes it covers and the next
  scan starts there.
- **Each telemetry segment** is summed once: its span of ticks and time,
  every system's durations as a histogram, main-thread time per tick,
  faults and troubles. A segment that has rolled closed never changes; the
  open one is summed again while its size differs; one the ring has
  deleted is dropped.

It is used only when it is of this very log: the same version, the same
session started at the same instant, and a log at least as long as what it
covers.

Building it for a full ring takes a few seconds; after that an answer
takes well under one.

### State at a moment

`state` and `why` need the ECS as it stood at a tick. Only the window can
be replayed, and a component last written before the window began has no
recorded value in it — that is reported as not recorded. Within the
window, the index will hold a checkpoint every so many ticks so a late
moment is a short replay.

### The live path

For `live`, logged data is read from the growing log exactly as for a
recording. Three things need the running process, over the agent's link:

- a heavy array's values, which the log holds only as a digest (`state`, `field`);
- a write (`set`);
- pause, resume and step.

What the link exposes for these today is not yet established; it is the
first thing step 3 settles.

## Shape of the code

The work lives in `@arcforge/platform`, here, and hangs off `Platform()` as
`platform.debug`. The CLI owns presentation only: arguments, the envelope,
exit codes (`apps/tui/cli/commands/debug.ts`).

```
Debug()                       the module's one door
 ├─ Sessions()                finds and names sessions; sizes; prune
 ├─ Log()                     reads a session log a line at a time
 ├─ Ring()                    reads telemetry segments
 ├─ Index()                   sums a session once, and keeps it up to date
 ├─ Graph()                   a declaration, and walks over it
 ├─ Perf()                    timings, from the index
 ├─ Events()                  events from log and ring, filtered, in one order
 ├─ Resources()               memory and its growth, CPU, GPU, threads
 ├─ Inference()               model calls: how often, how long, how many waiting
 ├─ Signs()                   what says a session is not well, one line each
 ├─ Overview()                the list of sessions, and one on one screen
 │
 ├─ Replay()                  not built — the ECS at a moment; history; causes
 ├─ Fields()                  not built — a field's numbers, and its picture
 └─ Live()                    not built — the running process
```

## Order of work

1. **Recordings, read-only.** Done. `sessions`, `session`, `graph`,
   `errors`, `events`, `perf`, `prune`.
2. **Values.** Checkpoints; `state`, `why`, `field` with PNG.
3. **Live.** Resident components in `state` and `field`; `set`, pause and
   step.

Each step ends with the commands documented here, tested, and a short note
in the repository's agent brief on when to reach for them.

## Not in scope

- Spawning agents, installing modules, placing an agent in a world. The
  existing CLI does these.
- Anything the debugger does that is about looking — layouts, widgets,
  timelines. `field --png` is the one picture.
- Editing code or configuration.

## Open

- **The compiled graph.** See The graph, above.
- **Agents by name.** `--agent` takes a directory. `@scope/name` is how the
  rest of the CLI names an agent, and should work here.
- **Troubles as a convention.** `errors` knows a component named `trouble`.
  If that is to hold for every cognet it belongs in the framework, not in
  one cognet's contract.
- **Checkpoint spacing.** How often, against how much disk. To be measured
  on a real session in step 2.
