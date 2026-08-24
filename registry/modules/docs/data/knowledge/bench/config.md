---
title: bench.config.ts
description: What varies, how many times, and what is measured.
---

# bench.config.ts

The config declares what *varies* and what is *measured*. Nothing about what the agent has
to do — that lives in [`tests/`](/docs/v2/bench/tests).

```ts
import { OpenRouter } from "@arcforge/engines"

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

Nothing is required. A benchmark with no matrix runs one cell; with no workspace it runs
against an empty world.

Identity is not here. Name, version and description live in
[`package.json`](/docs/v2/bench/package) — stating them twice is how the two come to
disagree.

## Fields

| | |
|---|---|
| `matrix` | what varies — see [The Matrix](/docs/v2/bench/matrix) |
| `trials` | repetitions per test × cell. Defaults to 1 |
| `workspace` | the agent's world and its retention policy |
| `tests` | globs for scenario files. Defaults to `tests/**/*.bench.ts` |
| `setup` | runs after the workspace copy, before the agent boots |
| `budget` | spend and time limits, per trial or per run |

The measurement schema is the type parameter, not a field. That is
[Measuring](/docs/v2/bench/measuring).

## trials

```ts
trials: 3
```

Repetitions of every test in every cell. Two models × three trials × one test is six runs.

The default is 1, and 1 is almost always wrong for a published result. Models are
stochastic: a single sample tells you what happened once, not what happens. Three is enough
to notice variance; ten or more is where the difference between two cells starts to carry
weight.

## setup

Runs once per iteration, after the workspace has been copied and before the subject boots —
the moment when the world exists but nothing has touched it:

```ts
async setup() {
    await Bun.$`bun install`.cwd(bench.workspace)
}
```

Installing dependencies, seeding a database, starting a service the task needs. Anything
that must be true of the world before the agent arrives.

It runs inside every iteration rather than once for the whole run, because a benchmark
whose setup leaked state between trials would stop being a controlled experiment.

## budget

```ts
budget: { perTrial: "$0.50", total: "$25" }
```

A ceiling, not a target. A trial that exceeds `perTrial` is stopped and recorded as a
`budget` fault — excluded from scoring rather than counted as a failure, because running out
of money is a statement about the experiment rather than about the agent.

Worth setting on anything with a real matrix. Two models × three trials × ten scenarios is
sixty agent runs, and an agent that loops is a bill that grows while you are not watching.

## Engines are imported, not global

```ts
import { OpenRouter, Codex } from "@arcforge/engines"
import { Mock, run } from "@arcforge/engines/mock"
```

Engine constructors are ordinary packages. They are declared in the benchmark's
`package.json` like any dependency, so a published benchmark carries exactly what it needs
to resolve them.

## What does not belong here

Scenario logic. If the config is deciding what the agent should do, that belongs in a test.

Presentation. There is no `chart` or `format` field, and this is deliberate: how a
measurement is drawn follows from what it *is* — a boolean across cells is a bar of rates, a
number with trials is a distribution, two axes make a grid. Declaring the chart as well
would mean stating the same fact twice and eventually disagreeing with yourself.
