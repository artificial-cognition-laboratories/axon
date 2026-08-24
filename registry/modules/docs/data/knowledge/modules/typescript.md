---
title: .module
---

# .module

Generated build output. `axon module prepare` writes this directory before publish.
You never edit it directly.

## What's in here

Type declarations for every tool function the module exports, packaged for merging
into the installing agent's type surface.

```ts
// src/tools/email.ts exports:
// export async function send(to: string, subject: string, body: string): Promise<void>
// export async function list(since: Date): Promise<Email[]>

// .module/email.d.ts declares:
declare namespace email {
    function send(to: string, subject: string, body: string): Promise<void>
    function list(since: Date): Promise<Email[]>
}
```

When the module is installed, these declarations are merged into the agent's
`axon.d.ts`. The agent author gets autocomplete on `axon.tools.email.*` without
any imports or manual wiring.

## Generating it

```bash
axon module prepare
```

Inspects `src/tools/`, resolves types, writes `.module/`. Run this before deploying.
`axon module deploy` runs `prepare` automatically if `.module/` is missing or stale.

## Committing

Commit `.module/`. It is a build artifact but a lightweight, human-readable one —
committing it means the type surface is visible in version control and does not
require running `prepare` after every clone.

Do not hand-edit it. Regenerated on every `prepare` run.
