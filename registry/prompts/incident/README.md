# @axon/incident

Respond to a live production problem — stabilise first, diagnose after.

Establish impact, restore service, preserve evidence, communicate, then investigate.

## Install

```bash
axon install @axon/incident
```

## Use

```bash
axon run @axon/incident --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/incident")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Enforces the separation that makes incidents shorter: the goal is stopping damage, not understanding it. It will not investigate root cause while the fire burns — it rolls back, disables, or scales first, in that order of preference.

It captures evidence before restarting, since a restart that fixes the symptom and erases the logs guarantees a second incident. And it won't state an unconfirmed cause, because an early wrong theory travels further than the correction.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
