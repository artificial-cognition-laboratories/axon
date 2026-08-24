# @axon/database-migration

Change a schema without data loss or downtime — expand, migrate, contract.

Old code and new schema must coexist. Destructive changes split across releases.

## Install

```bash
axon install @axon/database-migration
```

## Use

```bash
axon run @axon/database-migration --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/database-migration")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Enforces the rule that governs everything else: during any deploy, both code versions run against one database. So renames become three steps, never one. It requires a tested rollback, knows which operations lock a table, and states the deploy ordering explicitly — which is where migrations actually go wrong.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
