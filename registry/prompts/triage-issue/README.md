# @axon/triage-issue

Turn a reported issue into something actionable, or close it honestly.

Separate claim from observation, try to reproduce, classify, write a brief someone can act on.

## Install

```bash
axon install @axon/triage-issue
```

## Use

```bash
axon run @axon/triage-issue --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/triage-issue")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Splits what the reporter did, what happened, and what they expected — the third often reveals the software is behaving correctly. Reproduction is the step everything hinges on, and a failure to reproduce gets reported with exactly what was tried, since that's what lets the reporter spot the difference. It won't guess at a cause it hasn't traced.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
