# bench

## What This Is

Benchmarks as a project kind, alongside agents, modules, cognets and prompts. A
bench runs one scenario against many configurations of an agent and records
what happened, so a claim like "this cognet is better at refactoring" has
evidence under it.

Consumed by `axon bench init|prepare|run|result` and `axon publish` when the
nearest project is a bench. Published to the registry as a definition, so
someone else can clone it and run it against their own agent.

**This module owns benchmarking, not project management.** Finding, opening,
scaffolding, preparing and publishing a bench are `Project()`'s, exactly as for
every other kind — a bench's row in `build/project/kinds.ts` is what makes it a
kind. `Bench()` hangs off `project.bench` and holds only the verbs no other
kind has. There used to be a parallel `Benches()` manager duplicating find /
open / create / publish; it is gone.

## The Design

**One variable at a time, or a deliberate grid.** `matrix` is a plain object:
each key is a binding point, each value the variations to try there. One key
is the controlled experiment — the shape to reach for, because it is what
makes a result attributable. Several keys multiply, and the Cartesian growth
is the author's to manage rather than the runtime's to hide.

Keys are either named axes (`agent`, `cognet`, `model`, `env`) or dotted paths
into the blueprint (`config.engine.temperature`). The named set stays small
because the paths are the escape hatch. An earlier design had eight "factor
kinds" of which three were ever wired — the others (`dataset`, `judge`,
`toolset`) were not binding points at all, and modelling them as such is what
made the taxonomy grow.

**`expect` and `observe` are not the same tool.** A test encodes what you
already know should happen; a benchmark exists because you do not. So:

- `expect` — did the SCENARIO hold? Workspace copied, agent booted. A failure
  means the trial measures nothing and must stop rather than score zero.
- `observe` — how did the SUBJECT do? Recorded whatever the value is, never a
  failure. A model that scores badly is the finding.

This is why `observe` cannot collapse into `expect`: one halts on surprise,
the other records it, and a benchmark whose weak conditions all "failed" would
report itself as broken.

**Evidence, then projection.** `run()` executes and persists events; the
result is derived by REPLAY over that log. `BenchRunResult` deliberately holds
no aggregates — they are reproducible projections over the immutable record.
Physics (duration, tokens, cost, engine calls) are derived from the kernel log
with the author declaring nothing.

**Directories mean one thing each.**

```
bench.config.ts   matrix, measurements, setup
workspace/        the agent's world — copied fresh per iteration
fixtures/         author-side inputs; never visible to the agent
tests/            the scenarios, and where measurements are recorded
.bench/           generated declarations, run logs, materialized workspaces
```

The `workspace/` ↔ `fixtures/` split is an invariant, not a convention: if
fixtures leaked into the agent's view, a run would depend on the bench's own
layout and stop being reproducible.

## Key Interfaces

```typescript
const project = await platform.projects.openAs("bench", cwd)

await project.prepare()            // shared frame + the bench half below
await project.publish()            // ship the definition (never the results)

await project.bench.coordinates()  // the expanded matrix, without running
await project.bench.run()          // execute, persist, project → BenchRunResult
await project.bench.result(runId)  // rebuild a past result by replay
```

`project.bench` is null on every other kind, so reaching for a benchmark verb
on an agent is a type error rather than a runtime surprise.

Authoring surface, narrowed by generated declarations in `.bench/bench.d.ts`:

```typescript
bench.axis("model")              // the variation this cell got
bench.observe("resolved", true)  // a measurement
bench.attach("diff", patch)      // content-hashed evidence
```

## Known Debt

- **The workspace assertion API does not exist.** `registry/benches/benchmark0`
  contains `tests/fix-bug.bench.ts` written against the intended shape
  (`workspace.tests.pass()`, `workspace.changed()`) as the target to satisfy.
  Today `bench.workspace` is a bare path, so authors hand-roll `Bun.$`.
- **`toolCalls` is hardcoded to 0** in `preload.ts` — for coding benchmarks
  this is one of the most diagnostic numbers there is.
- **`aggregate.ts` and `contribution.ts` are types with no consumers.** The
  collective-submission layer (cohorts, tiers, shared aggregates) is designed
  and unwired. Worth building against a real result set rather than in the
  abstract — that is how they got ahead of the code in the first place.
- **Cases are unresolved.** `BenchTrialRecord.case` exists and nothing fills
  it. A dataset is the population you measure over, not an axis, so it must
  not enter the Cartesian product — but nothing expresses that yet.
