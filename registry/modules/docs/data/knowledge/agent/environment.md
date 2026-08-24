---
title: Environment & Secrets
---

# Environment & Secrets

The `.env` file at the agent root is the source of truth for the agent's environment
variables. It works like any other project's `.env` — no injection system, no side
channels, no per-environment re-declaration.

```bash
# my-agent/.env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxx
DATABASE_URL=postgres://localhost:5432/mydb
```

Standard dotenv format, parsed by Bun's native loader — quoted values, multiline
values, and comments all work.

## Giving the agent a key is explicit

Putting a key in the agent's `.env` *is* the act of giving the agent that key. There is
no other door: the capsule does not inherit your shell environment, and an agent
installed from the registry cannot silently read credentials from your machine. If a
key isn't in the agent's environment, the agent doesn't have it.

## How the agent reads keys

Inside the capsule, the environment is just `process.env` — tools and agent-emitted
code read it the way any Node or Bun code would:

```ts
// src/tools/github.ts
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
```

Nothing to declare, nothing to wire. The keys you gave the agent are in its
environment; everything else isn't.

## Keys travel with the agent

The `.env` belongs to the agent folder, so it goes where the folder goes. Deploy the
agent and its keys deploy with it — the agent reads `process.env` in the cloud exactly
as it did on your machine. No secrets dashboard, no environment-specific setup.

Two boundaries hold regardless:

- **Never committed** — `.env` is `.gitignore`d when `axon init` scaffolds the folder
- **Never published** — publishing an agent or module to the registry always excludes
  `.env`. Your keys ship with *your* deployments, never with shared source.

## Rotating a key

Update the value in `.env` and save. In local development the capsule hot-reloads and
future tool calls see the new value. For a deployed agent, redeploy.

---

Once the agent has a key, [Policy](/docs/v2/agent/policy) governs what it can actually
do with it — which hosts it can call, which files it can touch.
