# @axon/pull-request

Open a PR a reviewer can evaluate without reconstructing your reasoning.

Describes the whole branch against the merge-base — what, why, how, how verified, and what's not covered.

## Install

```bash
axon install @axon/pull-request
```

## Use

```bash
axon run @axon/pull-request --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/pull-request")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Forces it to state how the change was verified with actual results, flag the files that deserve attention versus mechanical noise, and surface its own uncertainty. It will not describe unverified work as verified — a false claim about a passing suite costs the reviewer their trust in every other line.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
