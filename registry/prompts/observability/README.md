# @axon/observability

Instrument the questions you'll ask at 3am, not the code you happen to be in.

Structured, correlated, honestly levelled. Untraced critical paths are treated as defects.

## Install

```bash
axon install @axon/observability
```

## Use

```bash
axon run @axon/observability --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/observability")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Starts from what you'd need to know when this breaks and works backwards, rather than logging function entry. It treats a significant operation that emits nothing as a bug in its own right, and names the paths that are currently invisible — usually the answer is "a timeout with no explanation", which is the case for fixing it.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
