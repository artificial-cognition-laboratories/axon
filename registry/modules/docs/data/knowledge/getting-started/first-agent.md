---
title: Your First Agent
---

# Your First Agent

When Axon boots it connects to a default agent — a general-purpose assistant with access
to your filesystem and shell. You can start talking to it immediately.

```bash
axon
```

::TerminalImage{src="/tui/emptyaxonconnectedtogpt55ready.webp" alt="Axon TUI showing a connected agent ready for input with tool count and thread ID visible in the header"}
::

Ask it to read a file. Watch it call a tool, reason over the result, and respond. That
loop — prompt, tool call, result, response — is what every agent you build will run on.
You're seeing the runtime in action before you've written a line.

When you're ready to build your own, keep going.

## Scaffold

```bash
axon init my-agent
cd my-agent
axon
```

This creates a real agent — not a stub. It boots, accepts sessions, and runs scripts out
of the box. Open the folder and you'll see why:

```bash
my-agent/
├── data/            # durable storage and knowledge
├── modules/         # installed capabilities
├── server/
│   └── api/         # HTTP routes (optional)
├── src/
│   ├── scripts/     # automations that orchestrate work
│   ├── tools/       # what it can do
│   └── boot.vue     # who the agent is
└── axon.config.ts   # identity, engine, policy
```

The agent is the folder. The runtime reads it at boot, discovers every tool and script,
and wires everything up. You never register handlers or configure a server — you edit files.

## Give it a personality

`src/boot.vue` is the agent's standing system prompt — rendered once at boot and present
for every session, every thread, every invocation. This is where the agent gets its
character.

```vue
<!-- src/boot.vue -->
<template>
    <h1>My Agent</h1>
    <p>You are a coding assistant working in this repository.</p>
    <p>You have access to the filesystem and can run shell commands.</p>
</template>
```

Edit this and the next session picks it up automatically. No restart, no rebuild.

## Give it something to do

Tools are async TypeScript functions in `src/tools/`. Export a function and the agent can
call it — Axon reads the signatures and JSDoc at boot and hands them to the model as
typed, documented capabilities.

```ts
// src/tools/fs.ts

/** Read a file from the repository. */
export async function readFile(path: string): Promise<string> {
    return Bun.file(path).text()
}
```

Scripts orchestrate the work. They load context, call the agent, process results — and
they run identically from the terminal, the TUI, an HTTP route, or another script.

```ts
// src/scripts/review.ts
const { file } = defineArgs<{ file: string }>()

const content = await axon.tools.fs.readFile(file)
const prompt = await axon.prompt("review", { file, content })

const { stream } = axon.stream({ prompt })

for await (const entry of stream) {
    if (entry.type === "text") process.stdout.write(entry.content)
}
```

```bash
axon run review --file src/index.ts
```

The agent boots, the script runs, the agent exits. Fast feedback — no session required.

## Ship it

When the agent is worth keeping around, one command puts it in the cloud:

```bash
axon deploy
```

Public URL, API key, durable storage. The same folder you've been editing, now a live
service — nothing about it changes. [Deploy](/docs/v2/deploy) covers the full story
when you're ready.

## Where to go from here

**Building** — [Agent](/docs/v2/agent) is the full authoring surface. Identity, tools,
scripts, policy, and the server layer — with real code throughout.

**Using** — the [TUI](/docs/v2/tui) is the full reference for the terminal interface.
Sessions, model switching, the palette, pages.
