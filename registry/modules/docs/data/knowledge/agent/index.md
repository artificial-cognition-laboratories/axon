---
title: Agent
---

# Agent

An agent is a TypeScript project with a shape Axon knows how to read. You author four
things: identity, tools, scripts, and policy. The loop, context assembly, tool dispatch,
session persistence, stop conditions — you write none of it.

Boot it in the TUI on your laptop, run it headless in CI, deploy it as a live cloud
service with a public URL and API key. The folder is the same in every case.

## Create one

```bash
axon init my-agent
cd my-agent
```

That scaffolds the project, installs the framework, and generates its types — you can
open `src/boot.vue` and start writing immediately.

Agents are the default project kind, so this is `axon init` with no noun in the middle.
Every other kind names itself: `axon module init`, `axon cognet init`, `axon bench init`.

Here's what you get:

```bash
my-agent/
├── data/            # durable storage and knowledge
├── modules/         # installed capabilities
├── server/          # HTTP routes, plugins (optional)
├── src/
│   ├── prompts/     # context it can load
│   ├── scripts/     # how work is orchestrated
│   ├── tools/       # what it can do
│   └── boot.vue     # who the agent is
├── tests/           # boot test to prove it runs
└── axon.config.ts   # engine, policy, environment
```

## The build journey

The **Build** section walks the authoring surface in the order you'll actually use it:

**[Identity](/docs/v2/agent/build/identity)** — `src/boot.vue` is the standing system
prompt. Edit it, save, and the running agent hot-reloads in ~40ms. This is where the
agent gets its character.

**[Tools](/docs/v2/agent/build/tools)** — export a function from `src/tools/` and the
agent can call it. Signatures and JSDoc become the model's documentation. No registration,
no schemas.

**[Scripts](/docs/v2/agent/build/scripts)** — TypeScript files that orchestrate work:
load context, call the agent, process results. One script runs identically from the
terminal, the TUI, an HTTP route, or another script.

**[Working with Agents](/docs/v2/fleet)** — when one agent isn't enough. Scripts that
boot several, agents that orchestrate other agents, how they talk, and how you debug a
system made of more than one.

**[Routes & Hooks](/docs/v2/concepts/events-and-inbox)** — `server/api/` makes the agent
addressable; hooks let it react when the outside world does something. This is how an
agent becomes a service instead of a session.

**[Policy](/docs/v2/agent/policy)** — declare what the agent may read, write, run, and
reach. Enforced structurally on every call, before the function runs. Not a prompt hint.

**[Testing](/docs/v2/agent/testing)** — boot the full runtime with a deterministic mock
engine. Test tools, prompts, and hook flows — the parts with correct answers.

## Capabilities you don't write

```bash
axon install @axon/github
axon install @axon/linear
```

Modules contribute typed tools, prompts, webhook routes, and boot-time setup. The
integration work is already done. See [Modules](/docs/v2/modules/overview).

## When something surprises you

**[Understand](/docs/v2/agent/managed-runtime)** holds the mental models — what the
runtime owns, how state and memory work, what the kernel enforces. Reach for it when
you want to know *why* the agent behaved the way it did.

**[Agent Structure](/docs/v2/agent/folder)** is the folder reference — every file, what
it does, what Axon does with it.

**[Internals](/docs/v2/concepts/runtime-loop)** is how it actually works under the hood. None
of it is required reading — that's the point of the platform.
