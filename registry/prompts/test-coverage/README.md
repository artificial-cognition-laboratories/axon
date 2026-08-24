# @axon/test-coverage

Find the untested code that matters and close the gaps worth closing.

Ranks gaps by what a bug would cost, then writes tests that could actually fail.

## Install

```bash
axon install @axon/test-coverage
```

## Use

```bash
axon run @axon/test-coverage --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/test-coverage")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Treats coverage as a map of blind spots rather than a target, because chasing a percentage produces tests that execute code without verifying it. Gaps get ranked by consequence — money, auth, and complex branching first; generated code and thin wrappers never. Every new test is watched failing before it's trusted.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
