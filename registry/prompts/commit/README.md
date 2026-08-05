# @axon/commit

Turn working changes into commits whose messages explain why.

Reads the actual diff, splits by intent, and matches the repo's existing message convention.

## Install

```bash
axon install @axon/commit
```

## Use

```bash
axon run @axon/commit --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/commit")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Writes the message from the diff rather than from memory of what it did, splits unrelated changes apart so each can be reverted alone, and never claims more than the change delivers. It checks for secrets before staging, not after pushing.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
