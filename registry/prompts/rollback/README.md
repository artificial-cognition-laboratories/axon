# @axon/rollback

Undo a change safely, accounting for the state that doesn't revert.

Confirm rollback is right, find what state moved, revert whole, verify the symptom.

## Install

```bash
axon install @axon/rollback
```

## Use

```bash
axon run @axon/rollback --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/rollback")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Focuses on where rollbacks actually go wrong: code reverts cleanly, the world doesn't. It establishes what state has moved — migrations, data written in a new shape, messages published, caches — and decides explicitly what happens to data written while the bad version was live.

It reverts the whole change rather than parts, since a partial revert produces a state nobody has tested or has a model of.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
