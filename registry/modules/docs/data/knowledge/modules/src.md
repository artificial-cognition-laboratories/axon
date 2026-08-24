---
title: src/
---

# src/

Tools and prompts contributed by the module. Everything in `src/` is merged into the
installing agent automatically — no wiring required.

## src/tools/

Each `.ts` file becomes a namespace on `axon.tools`, named after the file. A file
named `email.ts` contributes `axon.tools.email.*`:

```ts
// src/tools/email.ts
export async function send(to: string, subject: string, body: string): Promise<void> {
    const sgMail = (await import("@sendgrid/mail")).default
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!)
    await sgMail.send({ to, from: process.env.EMAIL_FROM!, subject, text: body })
}

export async function list(since: Date): Promise<Email[]> {
    // ...
}
```

After `axon prepare`, the installing agent gets full autocomplete:

```ts
await axon.tools.email.send(to, subject, body)
await axon.tools.email.list(new Date("2024-01-01"))
```

Keep tool functions focused — one action per export. The agent calls them by name;
short, clear names are better than long descriptive ones.

## src/prompts/

Prompt files in `.vue` format. Contributed prompts are available to the installing
agent via `axon.prompt("module-name/prompt-name")`.

```ts
// agent's plugin — load the module's contributed prompt
const prompt = await axon.prompt("discord/discord", { content, username })
```

The namespace prefix (`discord/`) is the module name. Contribute a prompt alongside
every hook your module emits — give the agent author something to start with rather
than making them write context from scratch.

## Auto-merge

When a module is installed, Axon merges its `src/` contributions into the agent
environment automatically:

- Tool functions become available on `axon.tools.<module-name>.*`
- Prompts become available via `axon.prompt("<module-name>/<prompt-name>")`
- Type declarations are merged into the agent's `axon.d.ts`

Run `axon prepare` after installing or updating a module to regenerate declarations.
