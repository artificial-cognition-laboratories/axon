---
title: Agent Folder
---

# Agent Folder

An agent is a folder at `~/.axon/agents/<name>/`. It is a standard Bun TypeScript project
with a shape Axon knows how to read.

```bash
my-agent/
├── .agent/               # generated — do not edit
├── data/                 # durable storage and knowledge
├── modules/              # installed capability packages
├── server/               # HTTP routes, plugins, middleware
├── src/                  # boot prompt, tools, prompts, scripts
├── tests/                # agent test files
├── .env                  # secrets — never committed, never published
├── axon.config.ts        # identity, engine, policy, environment
└── package.json          # dependencies
```

Your IDE understands it. You version control it. You install packages with `bun add`. The
shape is the only thing that makes it an agent.

## What each part does

**`axon.config.ts`** — the single file Axon reads at boot. Agent identity, which engine
to use, capsule policy, and environment configuration. One file, everything declared.

**`.env`** — agent-local secrets. Never committed, never published, never shared between
agents. Add API keys here.

**`src/`** — the agent's brain. Boot prompt, tools, prompts, and scripts. Everything the
agent knows and can do lives here.

**`tests/`** — Bun test files. The `Axon()` harness boots your full runtime against
`axon.config.ts`. Use `Mock()` as the engine so tests are deterministic and free.

**`server/`** — the HTTP layer. Routes expose the agent over HTTP. Plugins run at boot.
Middleware runs before each request.

**`data/`** — durable storage. Knowledge the agent reads, sessions Axon writes, state
modules persist. Grows over time; backed by durable storage in cloud deployments.

**`modules/`** — installed capability packages. Each module contributes tools, prompts,
scripts, and routes. Axon loads them automatically at boot.

**`.agent/`** — generated output. Type declarations, manifest, Docker artifacts. Recreated
by `axon prepare` and `axon build`. Never edit it manually.

## Auto-discovery

Everything in `src/` and `modules/` is discovered by filename — no registration, no
imports, no config entries.

```bash
src/tools/github.ts              → github.* tool namespace
src/prompts/code-review.md       → "code-review" prompt
src/prompts/session.vue          → "session" prompt
src/scripts/scout.ts             → "scout" script
modules/@axon/linear/src/tools/  → linear.* tool namespace
```

Add a file, it's available. Remove a file, it's gone. `axon prepare` regenerates type
declarations when you add or change tools.

## Creating an agent

```bash
axon init my-agent
```

Scaffolds the folder at `~/.axon/agents/my-agent/` with `axon.config.ts`, `.env`,
`package.json`, and `src/boot.vue`. Open it with `axon --agent my-agent`.

## What gets published

When you publish to the registry, Axon packages the source:

```bash
axon.config.ts    ✓ included
src/              ✓ included
server/           ✓ included
data/knowledge/   ✓ included
modules/          ✓ included (metadata only)
package.json      ✓ included
.env              ✗ excluded — never published
node_modules/     ✗ excluded — reinstalled on install
.agent/           ✗ excluded — regenerated on prepare
data/sessions/    ✗ excluded — local runtime state
```
