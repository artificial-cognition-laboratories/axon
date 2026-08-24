---
title: package.json
---

# package.json

The agent's Bun project manifest. Records everything installed into the agent — both Axon modules and plain npm packages.

```json
{
    "name": "my-agent",
    "version": "1.0.0",
    "dependencies": {
        "@axon/fs": "^1.2.0",
        "@axon/fetch": "^1.0.0",
        "@octokit/rest": "^20.0.0"
    }
}
```

## Axon modules

Installed via `axon install`. Their tools auto-register into the capsule — no wiring required. Their deps are merged into this file automatically and `bun install` runs.

```bash
axon install @author/dev-workflow
```

## npm packages

Installed via `bun add`. They land in `node_modules/` as private dependencies. They are **not** automatically available to the agent — to expose a package as an agent tool, export it explicitly from `src/`.

```bash
bun add @octokit/rest
```

```ts
// src/github.ts — explicitly surfaces @octokit/rest as agent tools
export async function createPr(title: string, body: string) { ... }
export async function listIssues(labels?: string[]) { ... }
```

This is the public/private boundary. `package.json` is your full dependency list. `src/` is what the agent actually sees.

## Committing

Commit `package.json`, not `node_modules/`. Anyone cloning your agent folder runs `bun install` to restore the environment.
