---
title: Hot Reload
---

# Hot Reload

Save a file. The agent updates. The session stays open, the thread history stays intact,
and the next turn uses the new surface.

Hot reload is scoped to the file that changed. Nothing outside that scope is disturbed.

## What changes and when

In-flight turns complete on the surface revision they started with. The reload is applied
after the runtime reaches a safe point — in-flight tool calls are allowed to finish first.
The next turn picks up the new surface.

This means you can edit a tool mid-conversation, save it, and the next message in the same
thread will have access to the updated implementation. The conversation history doesn't
move. The agent's position in the work doesn't move. Only the surface changes.

## What triggers a reload

| Changed file | What reloads |
|---|---|
| `src/tools/**` | Manifest rescanned, capsule replaced, tool declarations updated |
| `src/boot.vue`, `src/identity.md`, `src/system.md` | Identity text re-rendered for future turns |
| `.env` | Environment reloaded, capsule replaced |
| `package.json` | `bun install` runs, then capsule replaced |
| `src/prompts/**` | Prompt metadata rescanned |
| `src/scripts/**` | Script source updated for future invocations |

`axon.config.ts`, server routes, and module wiring require a process restart — their
effects are too broad to apply atomically to a running session.

## Capsule reloads

Tools and environment live inside the capsule subprocess. When either changes, the old
capsule is replaced with a new one. The swap is atomic — the old capsule handles any
in-flight tool calls to completion, then shuts down.

Module-level state inside `src/tools/` does not survive a capsule reload. Caches, SDK
clients, and open connections are recreated.

```ts
// src/tools/github.ts

// This is recreated on every capsule reload.
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export async function listOpenPrs() {
    const { data } = await octokit.pulls.list({ state: "open", ...repo() })
    return data.map(pr => ({ number: pr.number, title: pr.title }))
}
```

Module scope is the right place for cheap clients and caches. Anything the agent must
remember across reloads, restarts, or deploys belongs in `data/`.

## Thread history

Hot reload does not rewrite history. If you edit `boot.vue` mid-session, the entries
already in the thread were produced under the old identity — they stay exactly as they
were. The new identity applies to new work only.

Start a new session if you want a clean read of the updated agent from the beginning.
Stay in the same session to continue with the current working context on the new surface.

## Failure

A broken tool file, failed dependency install, or runtime boundary violation surfaces as a
reload failure in the thread. The runtime does not silently continue with a mixed surface.

Fix the file and save again. The watcher retries immediately.

For the state layers that hot reload operates on, see [State Model](/docs/v2/concepts/state-model).
