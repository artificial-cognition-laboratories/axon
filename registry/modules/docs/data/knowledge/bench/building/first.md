---
title: Your First Benchmark
description: A real bug, two models, end to end.
---

# Your First Benchmark

We are going to measure something concrete: given a genuine bug and a failing test suite,
which model fixes it — and does it touch anything it should not have?

```bash
axon bench init parser-bench
cd parser-bench
```

That scaffolds the whole structure. Four things to fill in.

## 1. Build the world

`workspace/` is what the agent will see. Put a small project in it with a real defect:

```ts
// workspace/src/parser.ts
export function parseLine(line: string): { key: string; value: string } {
    const [key, value] = line.split("=")
    return { key, value }
}
```

And the suite that catches it:

```ts
// workspace/tests/parser.test.ts
import { expect, it } from "bun:test"
import { parseLine } from "../src/parser"

it("parses a simple pair", () => {
    expect(parseLine("a=1")).toEqual({ key: "a", value: "1" })
})

it("keeps '=' inside the value", () => {
    expect(parseLine("url=http://x/?a=1")).toEqual({ key: "url", value: "http://x/?a=1" })
})

it("trims surrounding whitespace", () => {
    expect(parseLine("  a = 1  ")).toEqual({ key: "a", value: "1" })
})
```

One passes, two fail. `split("=")` drops everything after the second separator and nothing
trims. A real bug with a real test suite proving it — which is what makes the measurement
mean something.

## 2. Declare what you are measuring

```ts
type Schema = {
    /** Has the agent resolved the bug? */
    resolved: boolean

    /** Files edited beyond the target. @objective minimize */
    collateral: number
}
```

Two measurements. `resolved` needs no objective — more fixed bugs being better is obvious.
`collateral` does, because fewer touched files being better is not something a chart can
infer.

## 3. Declare what varies

```ts
import { OpenRouter } from "@arcforge/engines"

export default defineBench<Schema>({
    workspace: { source: "./workspace", retain: "failed" },

    matrix: {
        model: [
            OpenRouter({ model: "anthropic/claude-sonnet-4.6" }),
            OpenRouter({ model: "openai/gpt-5" }),
        ],
    },

    trials: 3,

    async setup() {
        await Bun.$`bun install`.cwd(bench.workspace)
    },
})
```

Two models, three trials: six runs. `setup()` installs the workspace's dependencies after
the copy and before the agent boots, so the test suite is runnable when the agent arrives.

Add the engines package so the import resolves:

```bash
bun add @arcforge/engines
```

## 4. Write the scenario

```ts
// tests/fix-bug.bench.ts
it("resolves the failing test", async ({ workspace }) => {
    expect(workspace).toHaveFile("src/parser.ts")

    const { axon } = await Axon()
    await axon.request("Two tests in tests/parser.test.ts are failing. Fix src/parser.ts so they pass.")

    observe("resolved", await workspace.tests.pass())
    observe("collateral", (await workspace.changed()).filter(f => f !== "src/parser.ts").length)

    await bench.attach("diff", await workspace.diff())
})
```

The `expect` guards the experiment — if `src/parser.ts` is missing, the world is wrong and
this trial measures nothing. The two `observe` calls record what happened, whatever it was.
The `attach` keeps the actual patch, because when a cell scores badly the diff is what tells
you why.

## Run it

```bash
axon bench prepare
axon bench run
```

```bash
Benchmark run 01JQZX8K2M4N6P8R
  4 passed, 2 failed, 12 observations
```

Twelve observations from six runs: two measurements each. The full record:

```bash
axon bench result 01JQZX8K2M4N6P8R
```

Every trial, its physics, its session, its observations, and the manifest pinning exactly
which model produced which number.

## What you did not have to write

Duration, token counts, cost, engine calls, tool calls, error counts. Which trials
completed and which faulted, and why. The full session for every run. Coverage — whether
every measurement you declared actually fired.

None of that is in the config or the test. It falls out of events the runtime already
emits, which means it is there for every benchmark ever written.

## Where to go next

Cut the cost of iterating to zero with [Testing with Mock](/docs/v2/bench/building/mock) —
the same six-run flow, no API keys, no spend.

Then [Publishing](/docs/v2/bench/building/publishing), so somebody else can run this against
their agent.
