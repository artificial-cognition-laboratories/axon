---
title: Mock
---

# Mock

A deterministic engine for testing. Replaces the inference step with a script you write
— the full agent loop still runs. Tool calls execute, the session log accumulates, stop
conditions fire. Everything behaves as in production, just without a model call.

## Configuration

```ts
import { Mock } from "@arcforge/engines/mock"

export default defineAgent({
    providers: [Mock()],
    model: "mock:mock",
})
```

With no argument, `Mock()` echoes the user's last message back as agent output. Useful
for testing routing and wiring without caring about content — and it's what a fresh
`axon init` boots with before an engine is configured.

## Response map

Map patterns to replies. Patterns are matched as case-insensitive substrings against
the last user message; on no match, Mock falls back to echo.

```ts
import { Mock } from "@arcforge/engines/mock"

export default defineAgent({
    engine: Mock({
        "hello": "Hi there!",
        "sprint status": "Two issues remain in review.",
    }),
})
```

A reply is a **step**: spoken text (ends the wake), or code to run via `run()` (the
loop continues so the model can see the result).

## Sequences

An array of steps plays out one per loop tick, in order. Once exhausted, further
matching calls repeat the last step.

```ts
import { Mock, run } from "@arcforge/engines/mock"

engine: Mock({
    "review the file": [
        run(`fs.read("src/index.ts")`),   // tick 1: act
        "The file looks correct.",         // tick 2: see the result, speak
    ],
})
```

`run()` executes real code in the real capsule, under the agent's real policy. The
result is committed to the session log and re-enters the loop on the next tick —
exactly the path a real model's tool call takes. This is what makes multi-step flows,
failure handling, and policy rejections deterministically testable.

## Function form

Full control — receives the engine request, returns the next step:

```ts
import { Mock } from "@arcforge/engines/mock"

engine: Mock(async (req) => {
    const last = req.messages.at(-1)?.content ?? ""
    return `You said: ${last}`
})
```

Return a string to speak, or `run(code)` to act.

## Streaming behaviour

Mock streams spoken text by chunking words with small delays, matching the feel of a
real streaming engine. Tests can iterate the stream normally.

## Output grammar

You never choose a grammar. A step describes *intent* — speak, or run code — and Mock
writes it in whichever dialect the agent's brain rendered, read from the contract block
in the request it was handed.

| step | classic | sfc |
|---|---|---|
| `"some text"` | `<text>` | `<template>` |
| `run(code)` | `<typescript>` | `<script>` |

This is why the same `Mock({ ... })` works against any cognet: the steps you write are
about behaviour, not syntax. It also means Mock exercises structured output for real —
a `run()` step becomes the `<script>` a declared `output` type is checked against.
