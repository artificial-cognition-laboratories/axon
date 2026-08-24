---
title: Vuedown
---

# Vuedown

Axon uses `.vue` files in `src/boot.vue`, `src/prompts/`, and `src/prompts/components/`
as a template format for generating text. This is **not** a web application. There is no
browser, no DOM, no hydration, no routing. The `.vue` file extension is reused because
Vue's template syntax is expressive enough to build data-driven prompts, and the existing
tooling ecosystem (Volar, Prettier, syntax highlighting) works without configuration.

The output is always a string — markdown, by default — that the agent reads as context.

## The mental model

Think of it like Markdown, but composable and programmable:

| | Markdown | Vuedown |
|---|---|---|
| Output | String | String (markdown) |
| Logic | None | `v-if`, `v-for` |
| Data | None | `await axon.tools.*` |
| Composition | None | Import components |
| Tooling | Any editor | Volar (Vue extension) |

A `.vue` file in Axon is a **template that renders to text**. Same syntax as a Vue
component, completely different purpose.

## What runs

The `<script setup>` block executes before render. Top-level `await` works. The `axon`
global is injected — no import needed. When the script finishes, the `<template>` renders
to a markdown string.

```vue
<script setup lang="ts">
// This runs at render time, not in a browser
const tasks = await axon.tools.kanban.list()
const next = tasks.find(t => t.status === "accepted")
</script>

<template>
    <h2>Current Task</h2>
    <p v-if="next">{{ next.title }}</p>
    <p v-else>No task assigned.</p>
</template>
```

The agent receives:

```markdown
## Current Task

Fix auth token refresh on mobile.
```

No React, no Vue runtime in a browser, no build step. The renderer (`@axon/vstr`) compiles
and runs the file server-side and returns the string.

## What doesn't work

`.vue` files in Axon are not full Vue components. These are explicitly not supported:

- `window`, `document`, `localStorage` — no DOM globals
- npm imports in `<script setup>` — stripped before evaluation. Pass npm results via `axon.tools` instead.
- `onMounted`, `onUnmounted` — no lifecycle hooks (one-shot render)
- `provide` / `inject` across component boundaries
- `defineEmits`, `defineExpose` — no-ops
- `<style>` blocks — silently ignored

If you need an npm package, consume it in a tool function in `src/tools/` and call
`axon.tools.yourTool.fn()` from the script block.

## Directives

Standard Vue template directives all work:

```vue
<template>
    <ul>
        <li v-for="item in items" :key="item.id">{{ item.title }}</li>
    </ul>
    <p v-if="urgent">⚠ Urgent items present</p>
    <p v-else>All clear.</p>
</template>
```

## Components

Components in `src/prompts/components/` are auto-imported globally. Any `.vue` file
there is available in `boot.vue` and all prompts without an import statement.

```vue
<!-- src/prompts/components/identity.vue -->
<template>
    <h2>Identity</h2>
    <p>You are Barry — a spec-driven automation agent...</p>
</template>
```

```vue
<!-- src/boot.vue — Identity is auto-imported, no import needed -->
<template>
    <h1>Barry</h1>
    <Identity />
    <Personality />
</template>
```

## Where `.vue` appears in an agent

| File | What it does |
|---|---|
| `src/boot.vue` | Standing system prompt, rendered as the agent's base identity |
| `src/prompts/*.vue` | On-demand context loaded via `axon.prompt("name")` |
| `src/prompts/components/*.vue` | Reusable fragments, auto-imported into boot and prompts |

All three use the same renderer. All three produce markdown strings. None of them are
web components.

## The `.md` alternative

Every `.vue` file has a plain markdown equivalent. For prompts that don't need live data
or composition, `.md` is simpler:

```markdown
<!-- src/prompts/code-review.md -->
---
args:
    - name: issueId
      required: true
---

Review the changes for issue {{issueId}}.
Check for correctness, test coverage, and style compliance.
```

Use `.md` when the instruction is static. Use `.vue` when it needs live data or
conditional structure.
