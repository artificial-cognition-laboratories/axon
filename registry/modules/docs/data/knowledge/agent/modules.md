---
title: modules/
icon: vscode-icons:default-folder
---

# modules/

`modules/` contains installed capability packages. Each module contributes tools, prompts,
scripts, and routes to the agent. Axon loads everything in `modules/` automatically at
boot — no imports, no registration.

```bash
modules/
└── @axon/
    ├── github/
    │   ├── server/
    │   │   └── api/
    │   ├── src/
    │   │   ├── prompts/
    │   │   └── tools/
    │   ├── module.config.ts
    │   └── package.json
    └── linear/
        ├── src/
        │   └── tools/
        └── module.config.ts
```

## Installing modules

```bash
axon install @axon/github
axon install @axon/linear
```

Modules land in `modules/` as source on disk. You can read every file, edit them, and
commit them to git.

## What modules contribute

Each module can add any combination of:

| Contribution | Where | How it's accessed |
|---|---|---|
| Tools | `src/tools/` | `axon.tools.<module>.*` |
| Prompts | `src/prompts/` | `axon.prompt("<module>:name")` |
| Scripts | `src/scripts/` | `axon run <module>:name` |
| Routes | `server/api/` | Mounted under `/api/` |

A module's tools land in a namespace derived from the module name. `@axon/github`
contributes `github.*`. `@axon/linear` contributes `linear.*`. They compose cleanly with
your own tools.

```ts
// your tool and a module tool — same API surface
const pr = await axon.tools.github.getPr(42)
const task = await axon.tools.kanban.nextTask()
```

## Namespacing

Module contributions are prefixed to prevent collisions:

```bash
modules/@axon/github/src/tools/pulls.ts  → github.*
modules/@axon/github/src/prompts/triage.md → "github:triage"
modules/@axon/github/src/scripts/pr-review.ts → "github:pr-review"
```

Your own tools in `src/tools/` are never prefixed — they're addressed directly. Workspace
tools from `.agents/` use the `workspace.*` prefix. Module tools use the module name.

## Modules run under your policy

Module tool calls go through the same capsule policy as your own tools. If your base
policy doesn't allow network calls to a host that a module tool needs, the call is blocked
— exactly as if your own tool tried it. Modules contribute capabilities; they don't gain
authority.

## Modules are source

The contents of `modules/` are ordinary source files. You can read them, modify them, and
understand exactly what an installed module does. If a module ships a webhook route, you
can read that route. If it emits hooks, you can see what events it fires.

For authoring and publishing your own modules, see [Modules](/docs/v2/modules/overview).
