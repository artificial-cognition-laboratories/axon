---
title: Results
description: What a run produces, why physics come free, and why aggregates are derived rather than stored.
---

# Results

A run executes every test in every cell, persists what happened as events, and then
derives its result by replaying that log.

The order matters. Execution writes evidence; the result is a reading of the evidence. Any
result can be rebuilt later without re-running anything:

```bash
axon bench result <run-id>
```

Same log, same projection, same numbers — six months later, on a different machine.

## What a run produces

```ts
{
    manifest,        // what was run: schema, cells, pins, harness identity
    trials,          // one record per test × cell × trial
    observations,    // every value you recorded
    artifacts,       // content-addressed evidence
    sessions,        // the full event stream per trial
    faults,          // harness failures, typed
    coverage,        // expected vs executed vs completed, and what is missing
}
```

No aggregates. No charts. Both are projections over this record, and storing a projection
next to the evidence for it is how the two drift apart.

## Physics come free

Every trial records what it cost, derived from the session log rather than declared by
you:

| | |
|---|---|
| `durationMs` | wall clock for the trial |
| `tokens` | input and output, summed across every engine call |
| `costUsd` | real spend, when the provider prices the call |
| `engineCalls` | how many times the model was consulted |
| `toolCalls` | how many times it reached for the world |
| `errors` | engine and run failures |

You declare none of this. It falls out of the events the runtime already emits, which
means it is available for every benchmark ever written, including ones whose authors never
thought about cost.

Physics are split between **subject** and **assessor**. When a benchmark uses a model to
judge another model's output, the judge's token spend is recorded separately — otherwise
the cost of measuring would be indistinguishable from the cost of the thing measured.

## Failure and low scores are different facts

A trial that failed is not a trial that scored badly, and the record keeps them apart.

**Faults** are harness failures, and they are typed:

| Code | Meaning |
|---|---|
| `boot` | the agent never started |
| `timeout` | the trial exceeded its budget |
| `budget` | the run exhausted its spend limit |
| `cancelled` | stopped deliberately |
| `process` | the subprocess died |
| `protocol` | the harness and the runtime disagreed |

A fault excludes the trial from scoring. It is not a zero, because a zero is a claim about
the agent and a fault is a statement about the experiment.

**Coverage** tracks the gap between what should have happened and what did:

```ts
{
    expectedTrials: 12,
    executedTrials: 12,
    completedTrials: 11,
    expectedMeasurements: 24,
    observedMeasurements: 21,
    missing: { fault: 2, not_emitted: 1 },
}
```

Most published benchmark numbers cannot distinguish "scored zero" from "never ran". This
one can, and the distinction is in the artifact rather than in a footnote someone wrote
afterwards.

## The manifest is what makes a result comparable

A result without a manifest is a number with no provenance. The manifest records:

- **The benchmark** — name, version, content hash
- **The schema** — every measurement declared, hashed
- **The cells** — every axis, including the ones held constant, each pinned to an
  immutable version or content hash
- **The workspace** — hash, file count, byte count
- **The harness** — Axon version, Bun version, protocol version

Held constants are in there for the same reason as varied ones. A score means nothing
without knowing what did not move alongside what did.

Pins are immutable identities, never mutable references. A cell that says
`model=claude-sonnet-4.6` records the resolved engine, not the tag that pointed at it, so
a result stays interpretable after the tag has moved on.

Secrets never enter the manifest. Values are pinned by hash, and an `env` axis records
that an environment varied without recording what was in it.

## Retaining the world

When a trial fails, the workspace it failed in is worth more than any number about it.

```ts
workspace: { source: "./workspace", retain: "failed" }
```

`failed` keeps the world of any trial that did not complete, `always` keeps every one, and
`never` keeps none. The failed world sits under `.bench/` exactly as the agent left it —
the half-applied patch, the file it should not have touched, the dependency it installed.

Workspace changes are captured as part of the trial record too, so a diff is available
even when the world itself was not retained.

## Reading a run

```bash
axon bench run
```

```bash
Benchmark run 01JQZX8K2M4N6P8R
  4 passed, 2 failed, 12 observations
```

```bash
axon bench result 01JQZX8K2M4N6P8R
```

The full record as JSON — every trial, every observation, every fault, with the manifest
that makes it mean something.
