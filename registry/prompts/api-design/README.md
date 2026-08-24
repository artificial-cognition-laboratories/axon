# @axon/api-design

Design an interface from the call site, then stress-test it against known futures.

Write the ideal call first, then the implementation. Make illegal states unrepresentable.

## Install

```bash
axon install @axon/api-design
```

## Use

```bash
axon run @axon/api-design --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/api-design")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Makes it write the call site before the implementation, so an awkward interface surfaces at the cheapest possible moment. Then it walks the design through futures you know are coming — async, batching, a second implementation — because a shape that survives three imagined futures is probably right. It presents rejected alternatives, which is where the real information is.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
