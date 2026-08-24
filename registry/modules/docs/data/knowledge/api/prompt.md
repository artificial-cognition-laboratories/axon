---
title: axon.prompt
---

# axon.prompt

Loads and renders a prompt from `src/prompts/`. Returns a rendered prompt object
ready to pass to `axon.request` or `axon.stream`.

```ts
const p = await axon.prompt("session")
const result = await axon.request({ prompt: p })
```

## With variables

Prompts are Vuedown files — they can declare variables in a `<script setup>` block.
Pass them as the second argument.

```ts
const review = await axon.prompt("code-review", {
    issueId: "bd-42",
    repository: "arclabs/axon",
})

const result = await axon.request({ prompt: review })
```

The values are interpolated into the prompt at render time. The agent receives the
fully rendered text.

## Composing prompts

`axon.request` and `axon.stream` accept an array of rendered prompts. Axon
concatenates them in order. This is the standard pattern for giving the agent both
a shared session context and a task-specific instruction.

```ts
const session = await axon.prompt("session")   // hydrates project state, kanban, etc.
const scout = await axon.prompt("scout")       // what to do this run

const { stream } = axon.stream({ prompt: [session, scout] })
```

The agent sees them as a single combined prompt. Order matters — earlier prompts
establish context that later prompts can reference.

## From installed modules

Modules can contribute prompts. They are loaded by name the same way:

```ts
const p = await axon.prompt("github/issue-triage", { number: 42, title: "..." })
```

The namespace prefix (`github/`) identifies the module. Run `axon prepare` after
installing a module to get type declarations for its contributed prompts.
