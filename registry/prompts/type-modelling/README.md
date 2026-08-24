# @axon/type-modelling

Make invalid states unrepresentable so bugs become compile errors.

Narrow at the boundary once, then trust it. Unions over flags, distinct types over primitives.

## Install

```bash
axon install @axon/type-modelling
```

## Use

```bash
axon run @axon/type-modelling --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/type-modelling")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Turns runtime checks into type constraints: when a function must validate its arguments, it asks why the signature allowed the bad value in the first place.

It knows where to stop, which matters as much as the technique — if the type is harder to understand than the bug it prevents, it isn't paying for itself. And it treats a cast used to silence a mismatch as the type system reporting that two shapes disagree, with one of them being wrong.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
