---
title: Modules
---

# Modules

A module is a packaged capability. Install one and your agent gains tools,
prompts, and integrations it didn't have before — without writing the glue
yourself.

This section is about **building** one. If you just want to use a module
someone else published, that is one command and it is covered in
[`axon install`](/docs/v2/cli/install) — you never need to read any
further than that.

## When you need one

A module reaches into the agent's build step and lifecycle. That is real power,
and it is real surface area: you are working with how the runtime loads things,
not just what it does.

Most people don't need that. If what you want to share is a task — an
instruction someone else can run — a [prompt](/docs/v2/agent/src/prompts) is
text, has no build step, and publishes in two commands.

Reach for a module when a prompt genuinely isn't enough: when you need to
contribute tools the agent can call, receive webhooks, or connect an external
service at boot.

## Create one

```bash
axon module init my-module
cd my-module
```

That scaffolds the package, installs the framework, and generates its types:

```bash
my-module/
├── server/
│   └── api/          # webhook handlers for external events
├── src/
│   ├── prompts/      # context templates
│   └── tools/        # async functions the agent can call
└── module.config.ts  # identity, env keys, what it contributes
```

Fill in `module.config.ts`, write a tool, and
[publish it](/docs/v2/modules/publishing) when it's ready.

## What a module can contribute

Any combination of:

- **Tools** — async functions in `src/tools/` the agent can call
- **Prompts** — context templates in `src/prompts/` for use at hook subscription sites
- **Routes** — webhook handlers in `server/api/` that receive external events
- **Setup** — boot-time lifecycle code that connects external services and emits hooks

One thing a module cannot do: touch the managed runtime directly. Policy, sessions,
the cognitive loop — those belong to Axon and the parent agent. Modules extend through
defined extension points only.

## The boundary

A module can add tools, hooks, and routes — it cannot replace the capsule or the loop.
Policy, sessions, the cognitive loop — those belong to Axon and the parent agent. Modules
extend through defined extension points only.

That boundary is what makes registry modules safe to install. They augment. They do
not take over.
