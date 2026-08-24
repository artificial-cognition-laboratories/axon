---
title: The Matrix
description: Binding points, variations, and why one variable at a time is the default.
---

# The Matrix

`matrix` declares what varies. Every key is a place in the agent; every value is a
variation to try there.

```ts
matrix: {
    model: [
        OpenRouter({ model: "anthropic/claude-sonnet-4.6" }),
        OpenRouter({ model: "openai/gpt-5" }),
    ],
}
```

Two variations, one key: two cells. Everything else about the agent is identical across
them, which is what makes any difference in the results attributable to the model.

## The key is the binding point

There is no separate declaration of what a variation *is*. The key says where it lands in
the assembled agent, and the runtime applies it during the normal boot.

| Key | What it replaces |
|---|---|
| `agent` | which agent project is loaded at all — a path, or a registry ref |
| `cognet` | the brain bundled into that agent |
| `model` | `config.engine` |
| `env` | environment variables, merged |

Four names, because four cover almost everything people want to compare. Anything else is
reachable by path:

```ts
matrix: {
    "config.engine.temperature": [0, 0.7, 1.0],
}
```

A dotted path addresses any location in the blueprint, and the values are merged there.
The named keys exist for ergonomics — `model` is easier to read than
`config.engine` — not because the runtime treats them specially.

This is why the named set stays small. The escape hatch means a new kind of comparison
never needs a new key, and a vocabulary that only grows is a vocabulary that eventually
means nothing.

## Agents come from a path or the registry

The `agent` axis takes either:

```ts
matrix: {
    agent: "./fixtures/subject",     // authored here, committed
}
```

```ts
matrix: {
    agent: "@axon/coding-base",      // a trusted base, fetched and pinned
}
```

A registry ref is resolved during `axon bench prepare`, materialized under
`.bench/agents/`, and prepared — dependencies installed, types generated — so a cell can
boot it. `@scope/name` means the registry; anything starting with `.` or `..` is a path.

The difference shows up in the manifest. A local agent pins the path you wrote; a registry
agent pins `@axon/coding-base@1.2.0`, which is an identity somebody else can run against.
That is what makes two people's results comparable rather than merely similar.

## Grids are a choice you make

Two keys multiply:

```ts
matrix: {
    model: [sonnet, gpt5],
    cognet: ["../zero", "../experimental"],
}
```

Four cells. Add `trials: 5` and that is twenty runs of every test. Add a third key with
three values and it is sixty.

The growth is not hidden and not capped. A grid is sometimes exactly right — you may
genuinely need to know whether a cognet's advantage holds across models — but it is a
decision with a cost, and the cost belongs in front of the person choosing to pay it.

**One key is the shape to reach for.** Changing a single variable is what makes a result
say something about that variable. Two models across two cognets tells you which
combination won; it does not cleanly tell you why.

## Variations are values, not names

You never write ids. They are derived from the variation itself:

```ts
matrix: {
    model: [OpenRouter({ model: "anthropic/claude-sonnet-4.6" })],
}
```

becomes the cell `model=anthropic-claude-sonnet-4.6`.

Derived from the value rather than the position, because position is not stable. If ids
were `model[0]` and `model[1]`, reordering the list would silently repoint every cell id
and results from an earlier run would stop lining up with the new ones — a comparison
that looks fine and is wrong.

When two variations derive the same id — two `Mock()` engines with different behaviour,
say — they are suffixed rather than rejected, since a pair the id cannot distinguish is
still a pair worth running.

## A single value is still an axis

```ts
matrix: {
    model: OpenRouter({ model: "anthropic/claude-sonnet-4.6" }),
}
```

No array needed for one variation — a bare value and a one-element list are the same
declaration. One cell, and the model is recorded in the manifest as a pinned constant.

Held constants are part of the result on purpose. A number is only comparable if you know
what did *not* vary alongside what did — a score against Sonnet 4.6 and a score against
GPT-5 are not the same measurement, even when the benchmark, the workspace, and every
test are identical.

## What the matrix cannot vary

A dataset. If a benchmark runs over 2,000 task instances, those instances are the
population you are measuring over — not variations you are comparing. Adding them as an
axis would multiply cells by 2,000 and produce a Cartesian product where you wanted a
sample.

That distinction is real and the shape for it is still being settled. Today a scenario
that needs many cases iterates them inside the test.

## Where variations reach the agent

Nothing in a test says which cell it is running in:

```ts
const { axon } = await Axon()
```

`Axon()` boots the subject with this cell's variation already applied. The scenario does
not branch on it, and could not sensibly do so — a test that behaves differently
depending on which model it got is no longer measuring the same thing across cells.

If you do need the current variation — for a label, or a workspace path — it is available:

```ts
const engine = bench.axis("model")
```

Typed from your own matrix, so it narrows to exactly the variations you declared.
