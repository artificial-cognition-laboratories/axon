---
title: Recipes
---

# Recipes

Full agent examples you can read like real projects.

Recipes are not isolated snippets. Each recipe is an agent folder with identity, prompts, policy, routes, tools, and knowledge working together.

The same pattern appears in every production Axon route: gather the request, render the relevant prompts, call `axon.stream()` with task context and any narrowed policy. Routes prepare the task state — they don't implement the loop.

```ts
export default defineEventHandler(async event => {
    const { repo, branch } = await readBody(event)
    const prompt = await axon.prompt("repo-review", { repo, branch })
    const { stream } = axon.stream({ prompt, policy: { network: { allow: ["api.github.com"] } } })
    return sendStream(event, stream)
})
```

## First recipe

[Coding Partner](/docs/v2/recipes/coding-partner) is a small custom coding assistant. It shows the core production pattern:

- `src/boot.vue` defines identity and operating rules.
- `src/prompts/*.vue` define reusable task framing with props.
- `server/api/chat.post.ts` handles interactive TUI messages.
- `server/api/repo-review.post.ts` exposes a headless review endpoint.
- `data/knowledge/repo-guidelines.md` gives the agent durable project rules.
- `axon.config.ts` and route policy keep the agent inside clear operating bounds.

## Why recipes are folders

The folder is the abstraction. A useful agent is not one endpoint or one prompt. It is the shape of the whole project: behavior, context, policy, tools, ingress, and durable data.

Start with [coding-partner/](/docs/v2/recipes/coding-partner), then open each file in the sidebar.
