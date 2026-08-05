# @axon/performance

Make something measurably faster — measure, profile, change one thing, re-measure.

Get a number, find where the time actually goes, change one thing, prove it worked.

## Install

```bash
axon install @axon/performance
```

## Use

```bash
axon run @axon/performance --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/performance")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Stops it optimising from a reading of the code. Nothing changes until there's a repeatable measurement and a profile, because intuition about where time goes is wrong often enough to cost a day and buy nothing. One change at a time, so you learn which one worked. It reports what it tried that didn't help, and stops when the target is met.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
