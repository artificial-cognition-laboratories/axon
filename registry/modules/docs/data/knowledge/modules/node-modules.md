---
title: node_modules/
---

# node_modules/

Local npm dependency tree. Populated by `bun install` during development, never
committed, never published.

```bash
bun install   # populates node_modules/ for local development
```

Your IDE resolves imports from here. Your `src/` code typechecks against it. That
is the only purpose of this directory during development.

## Never published

`node_modules/` is excluded from the registry package. When someone installs your
module, the registry ships source only. Their agent's `bun install` reconstructs
the dependency tree from `package.json`.

Add it to `.gitignore`.
