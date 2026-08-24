# @axon/caching

Add a cache without introducing a correctness bug.

Four questions before any code, expiry over invalidation, and the key must be complete.

## Install

```bash
axon install @axon/caching
```

## Use

```bash
axon run @axon/caching --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/caching")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Treats caching as the second answer, after checking whether the work can be avoided, batched, or indexed — fixes that don't add state and never go stale.

It forces four answers up front: how stale is acceptable as a number, what happens if it's wrong, what invalidates it, and what the key is. That last one catches the most serious caching bug there is — a cache keyed on the resource but not the viewer, serving one user's data to another.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
