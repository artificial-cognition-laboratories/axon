---
title: Module Folder
---

# Module Folder

A module is a folder. Everything Axon needs to install, type-check, and run it lives
here.

```bash
my-module/
├── .module/          # generated type declarations — commit, don't edit
├── node_modules/     # local dev deps — never committed
├── server/           # route and plugin contributions
│   └── api/
├── src/              # tools and prompts — auto-merged into the agent
├── tests/            # bun:test files — boot the parent agent, test the contribution surface
├── module.config.ts  # identity, env, options, emits, setup lifecycle
└── package.json      # npm deps and version
```

Only `module.config.ts` is required. Everything else is optional depending on what
the module contributes.

For the full authoring walkthrough, see [Building a Module](/docs/v2/modules/building).
