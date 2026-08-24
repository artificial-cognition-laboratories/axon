# @axon/config

Handle configuration and secrets so misconfiguration fails loudly at startup.

Validate at boot, default to safe, never default a secret.

## Install

```bash
axon install @axon/config
```

## Use

```bash
axon run @axon/config --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/config")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Makes configuration fail at startup with a message naming what's missing, rather than surfacing as a confusing null an hour later in whichever path needed it first.

Its defaults rules are the valuable part: default to safe rather than convenient, never default a secret, and never default something environment-specific — a production URL falling back to localhost fails silently while looking like it works. It also flags environment-name branching, since a dev bypass behind one is an auth hole waiting for a misconfiguration.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
