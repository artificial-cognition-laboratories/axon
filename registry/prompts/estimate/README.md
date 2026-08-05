# @axon/estimate

Break work into pieces and state the uncertainty instead of hiding it.

Decompose, count the forgotten work, give a range with what drives the spread.

## Install

```bash
axon install @axon/estimate
```

## Use

```bash
axon run @axon/estimate --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/estimate")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Refuses to give a number without decomposition, because most estimation error lives in work nobody listed rather than in mis-sized work that was. It explicitly counts the always-forgotten parts — tests, review round trips, migration, error paths, reading unfamiliar code.

It gives ranges and names what drives them, which is the actionable part: "three days if the parser handles this, two weeks if not — I can find out in an hour" identifies the cheap question that collapses the uncertainty.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
