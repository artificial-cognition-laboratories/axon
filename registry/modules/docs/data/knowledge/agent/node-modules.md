---
title: node_modules/
---

# node_modules/

The agent's installed dependency tree. Two different things end up here, and they behave differently.

## Axon modules vs npm packages

There are two kinds of things you install into an agent:

### Axon modules — tools auto-register

```bash
axon install @author/dev-workflow
```

Axon detects these as first-class modules. Their tools are auto-registered into the capsule — the agent can call them without you writing any wiring code. Installing an Axon module also merges its `src/`, `prompts/`, and `scripts/` files into your agent folder, and its npm deps land in `node_modules/`.

### npm packages — private by default

```bash
bun add @octokit/rest
```

A plain npm package installed into `node_modules/`. It is **not** automatically available to the agent as a tool. It is a private implementation dependency — available to your `src/` code to import, but invisible to the agent until you explicitly export it.

To surface it as an agent tool, export it from `src/`:

```ts
// src/github.ts
import { Octokit } from "@octokit/rest"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export async function createPr(title: string, body: string) {
    const { data } = await octokit.pulls.create({ ... })
    return { url: data.html_url }
}
```

Now the agent has a `github.createPr` tool. `@octokit/rest` is still private — the agent sees only what `src/` explicitly exposes.

This is the same public/private distinction as any TypeScript project. `node_modules/` is your private dependency tree. `src/` is your public API.

## What's in here at any given time

Everything `bun install` resolved from your `package.json` — tool packages from Axon modules, npm packages you added directly, and their transitive deps.

You don't manage this folder manually. It is a build artifact.

## Never commit it

`node_modules/` is reproduced by `bun install` from `package.json`. Commit `package.json`, not this folder.

```bash
bun install   # restores node_modules/ from package.json
```

## Removing a module

There is no `axon uninstall`. Because installed Axon modules merge their files directly into your agent folder, removing one means:

1. Deleting the `src/`, `prompts/`, and `scripts/` files the module added
2. Removing the module's deps from `package.json`
3. Running `bun install`

Your agent folder is yours — there's no hidden module layer to unpick. You see every file, you decide what stays.
