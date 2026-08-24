---
title: Testing with Mock
description: Exercise the whole benchmark flow with no API keys and no spend.
---

# Testing with Mock

A benchmark is code, and code has bugs. The problem is that finding them normally costs
money: every run of a two-model, three-trial matrix is six real agent invocations, and the
first five attempts are usually you discovering that a measurement id was wrong.

`Mock()` is a real engine that never calls a provider.

```ts
import { Mock, run } from "@arcforge/engines/mock"

matrix: {
    model: [
        Mock({ fix: run("export function parseLine(line: string) { /* correct */ }") }),
        Mock({ fix: "I can't do that" }),
    ],
}
```

Two cells, six runs with `trials: 3`, and the full pipeline exercised: matrix expansion,
subject binding, workspace copying, measurement collection, replay. Zero cost.

## Mocks vary behaviour, not labels

This matters more than it first appears. A mock that always says the same thing tests that
the harness runs; a mock whose *behaviour* differs per cell tests that the harness
**measures**.

```ts
matrix: {
    model: [
        Mock({ fix: run("...correct patch...") }),               // should score 1
        Mock({ fix: "I can't do that" }),                        // should score 0
        Mock({ fix: [run("...wrong..."), run("...right...")] }), // succeeds on retry
    ],
}
```

Three cells with three known outcomes. Run it, and the result should say exactly that. If
it does not, the bug is in your benchmark rather than in any model — which is precisely the
thing that is expensive to discover with real inference.

The third case is worth noting: an array is an ordered sequence, one step per matching
call. It is how you test that a benchmark handles an agent that gets there on the second
attempt.

## What a mock can do

```ts
Mock()                                   // echoes the user's message
Mock({ hello: "Hi there!" })             // substring match on the last user message
Mock({ fix: run("1 + 1") })              // execute code in the capsule
Mock({ fix: [run("..."), "done"] })      // ordered sequence
Mock((req) => `You said: ${req.messages.at(-1)?.content}`)
```

`run()` executes in the agent's capsule under the same policy as any other engine, which is
what makes a mock able to actually modify the workspace — and therefore able to make
`workspace.tests.pass()` return true.

## Distinguishing identical mocks

Cell ids come from the variation's value, and every `Mock()` derives the same name. When
that happens they are suffixed rather than rejected:

```bash
model=mock-1
model=mock-2
```

Two mocks with different reply maps are a meaningful pair even though their identity cannot
express the difference. Rejecting the config would be the wrong call; silently merging them
would be worse.

## Keep the real matrix nearby

The usual pattern is to develop against mocks and switch to real engines once the benchmark
itself is proven:

```ts
matrix: {
    model: [
        // Mock({ fix: run("...") }),
        // Mock({ fix: "I can't do that" }),
        OpenRouter({ model: "anthropic/claude-sonnet-4.6" }),
        OpenRouter({ model: "openai/gpt-5" }),
    ],
}
```

Nothing else in the benchmark changes. The scenario, the measurements, the workspace and
the assertions are identical — only what sits behind `Axon()` differs, which is the entire
point of the matrix being a binding point rather than a mode.

## What mocks cannot tell you

Whether the task is well-specified. A mock does exactly what you told it to, so a prompt
that would be ambiguous to a real model looks fine.

Whether the measurements are meaningful. Mocks confirm the pipeline records what happened;
only real runs reveal that `resolved` was measuring something narrower than you meant.

Use them to prove the benchmark works. Use real engines to find out whether it asks a good
question.
