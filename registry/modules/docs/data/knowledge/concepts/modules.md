---
title: Modules
---

# Modules

A module is an installable capability package. It contributes tools, prompts, scripts, and
routes to your agent — the same primitives you author yourself, shipped by someone else.

```bash
axon install @axon/github
```

After that command, your agent has `github.*` tools the agent can call, prompts for common
GitHub tasks, and a webhook route at `/api/webhooks/github` that the module manages.
Nothing to wire up. Nothing to configure beyond your API key in `.env`.

## What a module can contribute

**Tools** — async functions available to the agent under a typed namespace. `@axon/github`
contributes `github.openPr()`, `github.getPr()`, `github.createIssue()`, and others. The
agent sees them the same way it sees tools you write in `src/tools/`.

**Prompts** — reusable context templates your scripts can load. A module might ship a
`github/issue-context` prompt that hydrates everything about an issue in one call.

**Scripts** — automations you can invoke directly. `@axon/github` might ship a
`pr-review` script that loads the diff, runs the agent, and posts a comment.

**Routes** — HTTP endpoints the module registers alongside your own. A module that handles
webhooks ships the route that receives them and emits the hooks your plugins subscribe to.

## Where modules live

Installed modules land in `modules/` inside the agent folder:

```bash
my-agent/
└── modules/
    └── @axon/
        └── github/
            ├── server/
            │   └── api/
            ├── src/
            │   ├── prompts/
            │   └── tools/
            ├── module.config.ts
            └── package.json
```

They're source on disk, not a build artifact. You can read every file. Axon discovers them
automatically at boot — there's no registration step.

## Your agent stays in charge

Modules operate within your agent's policy. A module tool that tries to write outside the
paths your `fs` policy allows will be rejected exactly the same as if your own tool tried
it. The module doesn't declare its own policy — your base policy applies to everything
running in the capsule.

Modules also don't touch your boot prompt, your session state, or your conversation history.
They extend the surface area of what the agent can do; they don't change what the agent is.

## Composing your own tools with module tools

Module tools are available in scripts the same way your own tools are:

```ts
// src/scripts/pr-review.ts
const { domain } = defineArgs<{ pr: string }>()

// module tool — fetches PR metadata and diff
const pr = await axon.tools.github.getPr(parseInt(domain))

// your tool — reads your repo's style guide
const standards = await axon.tools.repo.getCodingStandards()

const review = await axon.prompt("code-review", { pr, standards })
const { stream } = axon.stream({ prompt: review })

for await (const entry of stream) {
    if (entry.type === "text") process.stdout.write(entry.content)
}
```

The agent sees module tools and your tools in the same typed namespace. From the agent's
perspective, there's no distinction between a tool you wrote and one a module contributed.

## Hooks from modules

Modules emit named hooks when things happen. You subscribe in your plugins:

```ts
// server/plugins/github.ts
export default defineAxonPlugin(async axon => {
    axon.hooks.hook("github:pr.opened", async ({ number, title, head }) => {
        const pr = await axon.tools.github.getPr(number)
        const prompt = await axon.prompt("pr-review", { pr })
        void axon.request({ prompt })
    })
})
```

The module routes the webhook and emits the hook. You decide what the agent does with it.
This separation means you can handle the same event differently from the module's default
behaviour, or handle it in multiple plugins for different purposes.

## The registry

Published modules are listed in the Axon registry. Browse them, read their source, and
see their declared policy before installing. A module's policy block is public — you can
see exactly what it's allowed to do on your machine before you install it.

```bash
axon install @axon/linear
axon install @axon/browser
axon install @axon/postgres
```

For authoring and publishing your own modules, see [Modules](/docs/v2/modules/overview).
