# @axon/onboard

Build an accurate mental model of an unfamiliar codebase, and say what you're unsure of.

Breadth before depth, then trace one real operation end to end.

## Install

```bash
axon install @axon/onboard
```

## Use

```bash
axon run @axon/onboard --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/onboard")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Reads in an order that builds a map before it builds understanding, then follows a single operation through every layer — which teaches more than an hour of skimming. It reports what it's still unsure about and marks where it inferred rather than verified, because confidently describing a half-understood system spreads a wrong model to everyone who reads the summary.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
