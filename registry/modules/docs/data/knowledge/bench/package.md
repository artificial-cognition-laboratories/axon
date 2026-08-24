---
title: package.json
description: Registry identity, version, and the engines a benchmark needs to resolve.
---

# package.json

A benchmark is a real package. This file carries the identity the registry uses and the
dependencies its config imports.

```json
{
  "name": "@you/parser-bench",
  "version": "0.1.0",
  "description": "Can an agent fix a real bug without collateral damage?",
  "type": "module",
  "dependencies": {
    "@arcforge/engines": "2.0.101"
  }
}
```

## Identity lives here

`name` and `version` are the registry's, not the config's. `bench.config.ts` describes what
the benchmark *measures*; this file says what it *is*.

Names are scoped — `@you/parser-bench`, not `parser-bench`. The registry refuses the flat
global namespace, and agents, modules, cognets and benches share one namespace, so a name
taken by any of them is taken for all.

## Dependencies

Whatever the config and tests import. In practice that means the engines a matrix names:

```ts
import { OpenRouter, Codex } from "@arcforge/engines"
import { Mock, run } from "@arcforge/engines/mock"
```

Declared here so a benchmark someone clones resolves the same engines you ran it with. A
matrix naming `OpenRouter` is not portable if the package is only present because it
happened to sit in your workspace.

The workspace has its own `package.json` when the task needs one, and it is entirely
separate — those are the agent's dependencies, installed inside the copied world, not the
benchmark's.

## Version and republishing

Registry versions are immutable. Bump before publishing again:

```bash
npm version patch
axon publish
```

Bump deliberately when what the benchmark *measures* changes, not only when the code does.
Results carry the schema hash, and a benchmark that quietly redefined a measurement would
otherwise let old and new numbers land in the same aggregate — which is worse than having
no aggregate at all.

## Visibility

```bash
axon publish            # private by default
axon publish --public   # listed in the registry
```

A private benchmark is visible to you and anyone in its org. See
[Publishing](/docs/v2/bench/building/publishing).
