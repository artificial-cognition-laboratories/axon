# @axon/code-comprehension

Understand a specific piece of code well enough to change it, and say what you're unsure of.

Follow the data, find out why the code is the way it is, then predict before you claim.

## Install

```bash
axon install @axon/code-comprehension
```

## Use

```bash
axon run @axon/code-comprehension --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/code-comprehension")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Stops it summarising code it pattern-matched rather than read. Names are treated as claims to verify, not facts. It traces a value through the code rather than skimming the call graph, and checks commits and tests to find out why odd-looking code exists — most strange code was a reasonable response to something, and the question is whether that something still holds.

It tests understanding by predicting output before running, and marks explicitly where it inferred rather than verified.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
