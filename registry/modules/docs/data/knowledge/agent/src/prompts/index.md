---
title: prompts/
icon: vscode-icons:default-folder
---

# prompts/

Prompts are reusable context loaded at invocation time. A prompt renders to a markdown
string that Axon passes into the agent's context for that call. It is not part of the
standing boot prompt — it's task-specific context loaded when a script or route decides
the agent needs it.

You don't assemble context by hand or pass raw strings into `axon.request()`. You write
prompts, load them by name, and compose them. The runtime handles rendering, concatenation,
and context budget from there.

The name is the file path relative to `prompts/`, without the extension:

```bash
src/prompts/code-review.md        → "code-review"
src/prompts/session.vue           → "session"
src/prompts/personas/linus.md     → "personas/linus"
```

No registration. Add a file, get a prompt.

These prompts belong to this agent. The same files can also be published on
their own as a prompt package — same formats,
same authoring rules, but the folder becomes the artifact and anyone can
install it. Moving one out is a matter of putting a `prompt.config.ts` beside
it.

## Two kinds

**Static (`.md`)** — plain markdown with optional frontmatter. What you write is what the
agent gets, with any declared args interpolated.

**Dynamic (`.vue`)** — template files that run `<script setup>` before rendering. Fetch
live data with `axon.tools`, branch on conditions, compose from components. The template
renders to a markdown string the agent receives fully populated. These are not web
components — [`.vue` here is a text template format](/docs/v2/concepts/vuedown).

## Static prompts

```markdown
Load the full context for issue {{issueId}}.
Run the show tool and read the output carefully.
Summarise the title, current status, and any open questions.
```

Use static prompts for instructions that don't depend on live data — personas, checklists,
workflow steps, reference guides.

## Dynamic prompts

```vue
<!-- src/prompts/session.vue -->
<script setup lang="ts">
const task = await kanban.nextTask()
const { proposals, accepted, done } = await axon.tools.kanban.list()
</script>

<template>
    <section>
        <h2>Current Kanban State</h2>
        <p>Proposals: {{ proposals.length }} · Accepted: {{ accepted.length }} · Done: {{ done.length }}</p>
    </section>

    <section v-if="task">
        <h2>Next Task</h2>
        <pre>{{ task.content }}</pre>
    </section>
</template>
```

`axon` is available in `<script setup>` — no import needed. Props declared via
`defineProps<{}>()` are the prompt's arguments, typed and validated before render.

Use dynamic prompts when the instruction quality depends on current state — live data,
fetched content, conditional structure.

## Loading prompts

Load from scripts and routes with `axon.prompt()`:

```ts
const session = await axon.prompt("session")
const review = await axon.prompt("code-review", { issueId: "bd-42" })

// compose — Axon concatenates in order
const { stream } = axon.stream({ prompt: [session, review] })
```

## Components

`src/prompts/components/` holds reusable Vue fragments auto-imported globally into
`boot.vue` and all dynamic prompts. No import statements needed.

Filename → PascalCase component name:
- `identity.vue` → `<Identity />`
- `working-practices.vue` → `<WorkingPractices />`
- `kanban-usage.vue` → `<KanbanUsage />`

```vue
<!-- boot.vue — components available without imports -->
<template>
    <h1>Barry</h1>
    <Identity />
    <Personality />
    <WorkingPractices />
</template>
```

Components are not prompts. They can't be loaded via `axon.prompt()` — they're building
blocks for boot and dynamic prompts only.

## TUI palette

Press `>` in the TUI, search for the prompt name, select it. Static prompts with declared
args show a text form. Dynamic prompts with typed `defineProps<{}>()` show typed controls:

| Prop type | Control |
|---|---|
| `string` | Text input |
| `number` | Number input |
| `boolean` | Toggle |
| `"a" \| "b"` | Dropdown |

The rendered prompt loads into the current session context and sends with the next message.

---

Next: [Scripts](/docs/v2/agent/build/scripts) — orchestrating the work.
