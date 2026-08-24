---
title: tests/
description: The scenarios — ordinary Bun tests that boot an agent and record what happened.
---

# tests/

Benchmark scenarios are standard Bun test files. No special harness, no benchmark-specific
runtime wrapper — you boot `Axon()` exactly as you would in an ordinary agent test.

```ts
it("resolves the failing test", async ({ workspace }) => {
    expect(workspace).toHaveFile("src/parser.ts")

    const { axon } = await Axon()
    await axon.request("Fix the failing test in src/parser.ts")

    observe("resolved", await workspace.tests.pass())
    observe("collateral", (await workspace.changed()).length - 1)
})
```

That file runs once per cell per trial. With two models and three trials, it runs six
times, each against a fresh copy of the workspace and an agent configured for that cell.

## The test does not know which cell it is in

`Axon()` boots the subject with the current variation already applied. Nothing in the test
selects a model or names a cognet, and that is deliberate: a scenario that branched on which
model it received would no longer be the same scenario across cells, and the comparison
would mean nothing.

If you need the current variation for a label or a path, it is available and typed from
your own matrix:

```ts
const engine = bench.axis("model")
```

Reach for it rarely. Wanting to *behave* differently per cell is usually a sign the
benchmark should be two benchmarks.

## expect guards, observe records

The one rule that separates a benchmark from a test suite:

```ts
// The scenario must hold, or this trial measured nothing.
expect(workspace).toHaveFile("src/parser.ts")

// The subject did something. Record it whatever it was.
observe("resolved", await workspace.tests.pass())
```

`expect` throwing excludes the trial rather than scoring it zero. `observe` never throws,
so a model that fails every trial produces a complete record of failing — which is the
finding, not a broken benchmark. See [Measuring](/docs/v2/bench/measuring).

## The workspace handle

Tests receive `workspace` as a test context argument — the agent's actual working directory
for this trial, plus the things a benchmark usually wants to ask about it:

```ts
await workspace.tests.pass()      // run the workspace's own suite
await workspace.changed()         // files the agent touched
await workspace.diff()            // the full patch
await workspace.read("src/x.ts")  // read a file
```

`changed()` and `diff()` work because the harness snapshots the world before the agent
boots. A test could not compute either on its own — by the time it runs, the original is
gone.

Matchers are available on the same handle:

```ts
expect(workspace).toHaveFile("src/parser.ts")
expect(workspace).toPassTests()
expect(workspace).toHaveChangedOnly(["src/parser.ts"])
```

## Multiple scenarios

One file per scenario, named for what it asks:

```bash
tests/
├── add-feature.bench.ts
├── fix-bug.bench.ts
└── refactor.bench.ts
```

Every scenario runs in every cell, and results are recorded per test. That is what lets a
result say *this model wins overall but loses on refactoring* — a single combined score
would have hidden it.

## Attaching evidence

Numbers say which cell won. Artifacts say what actually happened:

```ts
await bench.attach("diff", await workspace.diff())
```

Stored content-addressed, deduplicated by hash, and linked to the trial that produced it.

## Trials and determinism

Each trial is a fresh workspace and a fresh agent. Nothing carries between them — no
files, no session, no memory.

Which means `trials: 1` is measuring a single sample of a stochastic system. Models vary
run to run; one sample is an anecdote. Three is a minimum for noticing variance at all, and
ten or more is where a difference between two cells starts to mean something.
