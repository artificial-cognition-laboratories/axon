# @axon/refactor

Improve structure without changing behaviour, in small reversible steps.

Safety net first, one named improvement, one transformation at a time.

## Install

```bash
axon install @axon/refactor
```

## Use

```bash
axon run @axon/refactor --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/refactor")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Holds the one line that makes refactoring reviewable: never change behaviour and structure in the same commit. Bugs found along the way get noted, not fixed. If there's no test coverage it writes characterisation tests first — pinning current behaviour including the wrong-looking parts — because refactoring without a net is rewriting and hoping.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
