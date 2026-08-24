---
title: What is Axon?
description: A runtime and toolkit for building, running, and deploying reliable AI agents.
---

# What is Axon?

Axon is a runtime and toolkit for AI agents. It gives you a consistent way to define an
agent, give it capabilities, keep its sessions, and run it locally or in the cloud.

You write the behaviour that is unique to your agent. Axon handles the runtime around it:
context, tool calls, retries, sessions, and policy.

## A runtime, without the plumbing

Define what an agent knows, what it can do, and what it is allowed to access. Axon then
assembles the context, runs the loop, dispatches tools, persists sessions, and enforces the
policy you set. The application boundary is a single call:

```ts
const { stream } = axon.stream({ prompt: [session, task] })
```

You receive a stream of entries and decide what your application does with them. The
runtime concerns stay in one maintained system instead of being rebuilt for every agent.

## Add capabilities as modules

Integrations such as GitHub, Linear, Discord, and Stripe are modules. Install one and it
brings its typed tools, client setup, event handling, and any required verification with it.

```bash
axon install @axon/github
axon install @axon/linear
```

Your agent can then use documented calls such as `github.openPr`, `github.getPrDiff`, and
`linear.createIssue`. The integration is installed; it is not another subsystem for you to
maintain.

Browse the available modules in the [registry](/docs/agents).

## Work with the agent

::TerminalImage{src="/tui/axontuiemptychatwindowcleanlanding.webp" alt="Axon TUI clean landing screen showing the Axon braille logo, connected agent name, model, thread ID, and registered tool count"}
::

The terminal interface is where you run and inspect an agent. Tool calls are visible,
and sessions are navigable without leaving the conversation.

Commands stay close to hand: `^` opens sessions, `*` changes model, and `>` loads a
prompt into the input.

::TerminalImage{src="/tui/axontuiwithscriptspaletteopen.webp" alt="TUI with the script palette open, showing available scripts from the active agent"}
::

It can also manage Ollama. Browse compatible local models, start a download, and switch
between local and cloud inference without changing the agent.

::TerminalImage{src="/tui/axonmodelpaletteopenshowingdownloadinglocalmodel.webp" alt="TUI model palette on the local tab showing an Ollama model downloading with progress indicator"}
::

## Deploy when it is ready

```bash
axon deploy
```

Axon deploys the same project with a public URL, API key, and durable cloud storage. When
you need your own infrastructure, `axon build` produces a Docker image for any container
platform.

---

An Axon agent is a project folder: its configuration, modules, and source travel together.
It is not tied to a model vendor or a hosting provider.

Start with [Installation](/docs/v2/getting-started/installation), then build [your first
agent](/docs/v2/getting-started/first-agent).
