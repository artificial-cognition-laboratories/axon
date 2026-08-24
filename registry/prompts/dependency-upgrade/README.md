# @axon/dependency-upgrade

Move dependencies forward safely, reading changelogs before bumping.

Separates security from housekeeping, reads every intervening changelog, upgrades in revertible steps.

## Install

```bash
axon install @axon/dependency-upgrade
```

## Use

```bash
axon run @axon/dependency-upgrade --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/dependency-upgrade")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Makes it read the changelog between current and target — every major, not just the newest — before touching a version. Upgrades go one package at a time so a failure points at a cause. Critically, it won't silence a new type error to make the build pass, and it reports which upgrades are actually exercised by tests versus merely typechecked.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
