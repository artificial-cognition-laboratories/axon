# @axon/document

Write documentation that answers the question the reader arrived with.

Four kinds with different rules — tutorial, how-to, reference, explanation. Don't mix them.

## Install

```bash
axon install @axon/document
```

## Use

```bash
axon run @axon/document --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/document")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Makes it decide which kind of document this is before writing, since mixing them is the common failure: a tutorial interrupted by API detail serves neither reader. Every example gets verified by running it. And it won't document what the code already says — a comment restating a signature is a thing to keep in sync that carries no information.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
