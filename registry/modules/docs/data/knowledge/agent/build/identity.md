---
title: Identity
---

# Identity

`src/boot.vue` is the agent's standing system prompt — rendered once at boot, present
for every session and every invocation. Whatever you put here is who the agent is.

```vue
<!-- src/boot.vue -->
<template>
    <h1>Barry</h1>

    <p>
        You are a senior engineering partner embedded in this codebase.
        You have full access to the repo, the issue tracker, and CI.
    </p>

    <WorkingPractices />
    <KanbanContext />
</template>
```

It's a Vue component that renders to Markdown. That buys you composition: split identity
into sections, reuse fragments across prompts, load knowledge files at render time.
`<WorkingPractices />` and `<KanbanContext />` are components from
`src/prompts/components/` — auto-imported, no registration.

## The edit loop

Save `boot.vue` and the running agent hot-reloads it — about 40ms, session intact. Ask
the agent its name, edit the `<h1>`, save, ask again. The next turn answers from the new
identity; the thread history already produced stays exactly as it was.

This is the core authoring loop. Identity is source, committed to git, versioned like
everything else — not a settings field, not conversation history that drifts.

## What belongs here

Boot identity is *standing* orientation — true for every task the agent will ever do:

- Who the agent is and how it works
- Standing rules and working practices
- Durable knowledge the agent should always have loaded

Task-specific context does not belong here. A code review needs the diff; a triage run
needs the issue. Those are [prompts](/docs/v2/agent/src/prompts) — loaded per
invocation, gone when it completes. Keep `boot.vue` stable and small; if it changes per
task, it's a prompt.

## Loading knowledge

Dynamic sections can read files at render time — the standard pattern for giving the
agent durable, accumulated knowledge:

```vue
<!-- src/prompts/components/KanbanContext.vue -->
<script setup>
const board = await readFile("data/knowledge/kanban.md")
</script>

<template>
    <h2>Current Board</h2>
    <p>{{ board }}</p>
</template>
```

The agent arrives pre-oriented on every boot. How that knowledge accumulates is covered
in [State & Memory](/docs/v2/concepts/state-model).

---

Next: [Tools](/docs/v2/agent/build/tools) — giving the agent something to do.
