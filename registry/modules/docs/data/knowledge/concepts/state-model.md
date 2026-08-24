---
title: State & Memory
---

# State & Memory

An agent isn't a stateless function. Between a bare `axon.request("hello")` and a
multi-day project there are four layers of state, each with its own scope and lifetime.
Knowing which layer holds what explains why the agent remembers some things and not
others — and how to make it remember the things you want.

| Layer | Scope | Lifetime |
|---|---|---|
| Base state | All sessions | Changes when source changes |
| Session state | One working session | Boot to shutdown |
| Conversation state | One booted agent | Boot to shutdown |
| Request context | One invocation | Cleared when the loop completes |

## Base state

Base state is what the agent is when nothing is happening. It comes entirely from the
agent folder: `boot.vue`, tools, prompts, config, installed modules. Nothing that
happens during execution changes it — which is why identity and working practices don't
drift over a session. They come from source, not from conversation history.

In local development, [hot reload](/docs/v2/concepts/hot-reload) applies source edits to
future work without rewriting existing history.

## Session state

A session is the agent's lifetime — from boot to shutdown. Everything in between —
every exchange, every tool call, every file written — belongs to it. The three session
shapes have different lifetimes:

```bash
axon              # TUI — session lasts until you close it
axon run scout    # Script — session lasts one script run
axon deploy       # Cloud — session spans requests; restarts after idle periods
```

The cloud shape is the one that surprises people: a deployed agent's session can end
and restart with scaling events. What never restarts is `data/` — session traces,
knowledge files, and anything the agent has written survive cold starts and redeploys.
**The session is ephemeral. The folder is not.**

## Conversation state

A booted agent is one continuous conversation. It sees everything it has said and done
this session on every call, and nothing from any other agent. There is no sub-context to
address inside it — isolation comes from booting a second agent, not from partitioning
one.

The composition patterns — parallel branches, keeping noisy work out of the main
context, passing conclusions between agents — are covered in
[Fleet](/docs/v2/fleet).

## Request context

Request context is what you pass to a single invocation — rendered prompts, policy
narrowing, inline data. It's consumed and cleared when the loop completes. Loading a
support ticket for one invocation doesn't permanently teach the agent about that
ticket; the next invocation starts clean.

This is what makes agents predictable: a hundred tasks in a day, no cross-contamination
between them.

## What persists, and where

Three mechanisms, from automatic to deliberate:

### Session traces — automatic

The runtime writes every session to `data/sessions/` as a JSONL trace — every entry,
every tool call, every result. It is the record of what happened, readable after the
fact. You don't manage this and there's no persistence API to call.

### Knowledge files — deliberate

`data/knowledge/` is yours by convention: scripts write here during execution, the boot
prompt reads here at render time. It's accumulated memory the agent builds on purpose —
what it has learned about a domain, a codebase, a set of rules.

```ts
// src/scripts/learn.ts
const result = await axon.request({ prompt: [context, learnPrompt] })

const match = result.text.match(/```knowledge\n([\s\S]*?)```/)
if (match) {
    await writeFile("data/knowledge/domains/tracing.md", match[1].trim())
}
```

Next boot, `boot.vue` loads the file. The agent arrives pre-oriented — it starts from
where it left off, not from scratch.

### The folder — durable everywhere

In cloud deployments, `data/` is backed by durable storage transparently. The agent
calls `writeFile` the same way locally and in production; no storage SDK, no
environment checks. The folder is not just source — it is live runtime state.

## The progression

Most agents are stateless execution units. Axon agents can compound:

1. **Passive persistence** — traces written automatically; the agent remembers what happened.
2. **Active accumulation** — scripts write knowledge; memory grows deliberately.
3. **Capability expansion** — policy permitting, the agent writes a new tool or installs
   a module. Next session it can do something it couldn't before.
4. **Shared state** — the [`.agents/` workspace standard](/docs/v2/workspace) lets
   knowledge and tools be shared across every agent working the same repo.

None of these require implementing anything. The folder is the interface; the agent
writes files; the runtime handles the rest.
