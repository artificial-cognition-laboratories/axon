# @axon/cleanup

Remove debug instrumentation, dead code, and stale comments before shipping.

Knows the difference between unused and unreachable.

## Install

```bash
axon install @axon/cleanup
```

## Use

```bash
axon run @axon/cleanup --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/cleanup")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Removes the things that shouldn't ship, but demands proof before deleting anything non-trivial — "I can't find a caller" is not "there is no caller". It checks for dynamic access, public exports, config references, and platform-invoked entry points, and reports unproven candidates rather than deleting them.

It also keeps cleanup as its own change, since deletions mixed into a feature make both unreviewable.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
