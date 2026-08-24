# @axon/concurrency

Reason about code where more than one thing happens at once.

Find the shared mutable state, check the interleavings, bound everything.

## Install

```bash
axon install @axon/concurrency
```

## Use

```bash
axon run @axon/concurrency --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/concurrency")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Approaches concurrent code assuming it has missed something — which is correct, because the failure mode here is confidence. Code that looks obviously right is exactly what deadlocks under load six weeks later.

It hunts the specific patterns: check-then-act, read-modify-write, state held across a suspension point, lock ordering, unbounded fan-out, assumed completion order. And it states its reasoning about interleavings rather than asserting correctness, because a passing test proves very little here.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
