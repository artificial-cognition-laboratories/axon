---
title: Benchmarks
description: Controlled experiments over agents — change one variable, hold everything else, measure what moves.
---

# Benchmarks

"How good is this agent?" has never had a real answer. Not because measurement is hard,
but because *agent* was never a standardized thing — every framework's agent is a
different shape, so no result transfers, no comparison holds, and every eval is a
one-off script someone wrote and nobody can rerun.

Axon agents are a standard shape. That makes them benchmarkable, and it makes benchmarks
portable, publishable, and comparable — the same as agents and modules.

## The whole model in four sentences

Authors declare **what varies** and **how many times to repeat**. The runtime runs every
test against every declaration, holding everything else constant. Tests are ordinary Bun
tests that emit typed observations about what happened. Everything else — duration,
tokens, cost, failures, coverage — is recorded without you asking.

That's the system. The rest of this section is consequences.

## Create one

```bash
axon bench init my-bench
cd my-bench
```

That scaffolds the benchmark, installs the framework, and generates its types:

```bash
my-bench/
├── fixtures/              # author-side inputs
├── tests/
│   └── example.bench.ts   # a test that emits observations
├── workspace/             # the tree each run gets a fresh copy of
├── bench.config.ts        # the matrix: what varies, how many trials
└── README.md
```

Then `axon bench run` executes the matrix, and `axon bench result` reads back what
happened. Here's the shape of what you'll be editing:

```ts
import { Mock, run } from "@arcforge/engines/mock"

type Schema = {
    /** Has the agent resolved the bug? */
    resolved: boolean

    /** Files edited beyond the target. @objective minimize */
    collateral: number
}

export default defineBench<Schema>({
    workspace: { source: "./workspace", retain: "failed" },

    matrix: {
        model: [
            OpenRouter({ model: "anthropic/claude-sonnet-4.6" }),
            OpenRouter({ model: "openai/gpt-5" }),
        ],
    },

    trials: 3,
})
```

```ts
// tests/fix-bug.bench.ts
it("resolves the failing test", async ({ workspace }) => {
    expect(workspace).toHaveFile("src/parser.ts")

    const { axon } = await Axon()
    await axon.request("Fix the failing test in src/parser.ts")

    observe("resolved", await workspace.tests.pass())
    observe("collateral", (await workspace.changed()).length - 1)
})
```

Two models, three trials each, one scenario: six runs, twelve observations, and a full
session log for every one of them.

## A benchmark is a controlled experiment

The idea is old-fashioned science: hold everything constant, vary one thing, measure what
changes.

`matrix` is that one thing. Every key is a binding point in the agent — the model, the
cognet, the whole agent, any path into its config — and every value is a variation to
try. One key is a controlled experiment. Several keys multiply into a grid, which is
sometimes what you want and always a decision you made rather than one the runtime made
for you.

The harness is the same `Axon()` runtime used everywhere else. Each cell applies its
variation to the normal boot, so the thing you measure is the thing that runs in
production.

## A benchmark is a folder

Like everything else in Axon:

```bash
my-bench/
├── .bench/             # generated types, run logs, materialized workspaces
├── fixtures/           # author-side inputs — never visible to the agent
├── tests/              # the scenarios
│   └── fix-bug.bench.ts
├── workspace/          # the agent's world — copied fresh for every run
├── bench.config.ts     # what varies, and what is measured
└── package.json
```

Each directory means exactly one thing, and the `workspace/` ↔ `fixtures/` split is a
guarantee rather than a convention. The agent sees `workspace/` and nothing else. Rubrics,
expected outputs, and setup data live in `fixtures/`, where the subject cannot read them
and a run cannot come to depend on the benchmark's own layout.

## Tests measure, they do not judge

A test suite says *these assertions must hold or I am unhappy*. A benchmark cannot say
that, because it exists precisely when you do not know what will happen. Halting on the
first surprise is the opposite of what you want.

So benchmarks have two verbs, and the difference is intent:

- **`expect`** — did the *scenario* hold? The workspace copied, the agent booted, the
  file the task refers to exists. A failure here means this run measured nothing, and it
  is excluded rather than scored zero.
- **`observe`** — how did the *subject* do? Recorded whatever the value is. A model that
  fails every trial is the finding, not a broken benchmark.

That single rule is most of what separates writing a benchmark from writing tests. See
[Measuring](/docs/v2/bench/measuring).

## What you get without asking for it

Every trial records its own physics, derived from the session log rather than declared:

| | |
|---|---|
| `durationMs` | wall clock for the trial |
| `tokens` | input and output, summed across every engine call |
| `costUsd` | real spend, when the provider prices the call |
| `engineCalls` | how many times the model was consulted |
| `toolCalls` | how many times it reached for the world |
| `errors` | engine and run failures |

Alongside faults (typed: `boot`, `timeout`, `budget`, `cancelled`, `process`, `protocol`),
the full session for every trial, and coverage — expected versus executed versus
completed, and *why* anything is missing.

That last one matters more than it sounds. Most published benchmark numbers cannot
distinguish "scored zero" from "never ran". Here they are different facts, and both are in
the record.

## Results are evidence, not summaries

A run executes, persists events, and derives its result by replaying that log. The result
holds trials, observations, artifacts, sessions, faults, and coverage — and deliberately
holds no aggregates or charts.

Both are projections over the record. Storing them would mean storing a claim next to the
evidence for it, and the two can drift. Deriving them means a result from six months ago
can answer a question nobody had asked yet.

## Benchmarks are registry artifacts

`axon publish` ships a benchmark the same way it ships an agent or a module, and
`axon clone` brings it down to run against your own work.

What ships is the *definition* — config, tests, workspace. Results are not part of the
artifact: a run's observations belong to whoever spent the tokens producing them, and
publishing a benchmark is a different act from publishing a score.

## Start here

**[The Matrix](/docs/v2/bench/matrix)** — binding points, dotted paths, and why one
variable is the default rather than a limitation.

**[Measuring](/docs/v2/bench/measuring)** — `expect` versus `observe`, and declaring a
schema as a TypeScript type.

**[Results](/docs/v2/bench/results)** — what a run produces, and why aggregates are
derived rather than stored.

**[Your First Benchmark](/docs/v2/bench/building/first)** — a real bug, two models, end
to end.

**[Testing with Mock](/docs/v2/bench/building/mock)** — exercise the whole flow with no
API keys and no spend.
