---
title: boot.vue
icon: vscode-icons:file-type-vue
---

# boot.vue

`src/boot.vue` is the agent's standing system prompt. It forms the base context for every
session and task, and hot-reloads in local development for future work.

Put here what the agent should always know: who it is, how it operates, what it's working
on, what standards it holds. This is the context the runtime can safely include for every
invocation without thinking about it.

## Vue composition (recommended)

The `.vue` format lets you compose identity from reusable components. Components in
`src/prompts/components/` are auto-imported — no import statements needed. `boot.vue` is
not a web component — [`.vue` here is a text template format](/docs/v2/concepts/vuedown).

```vue
<!-- src/boot.vue -->
<template>
    <h1>Barry</h1>
    <Identity />
    <Personality />
    <WorkingPractices />
</template>
```

Each component is a `.vue` file in `src/prompts/components/` that renders a section of
the system prompt. This lets you split a long boot prompt into named, composable pieces
without duplicating content across agents or prompts.

## Markdown fallback

For simple agents, `src/boot.md` works as a plain markdown file:

```markdown
# Boot

You are a coding assistant working in this repository.
Read the codebase before making suggestions.
Prefer small, focused changes over large rewrites.
```

## What belongs here

- Agent identity — name, role, tone
- Standing operating rules and constraints
- Project conventions and layout
- Anything true across every task this agent handles

## What doesn't belong here

- Current tickets, incidents, or task details — those go in prompts loaded at invocation
- Secrets or environment values — those go in `.env`
- One-off instructions — those go in a prompt or directly in a script