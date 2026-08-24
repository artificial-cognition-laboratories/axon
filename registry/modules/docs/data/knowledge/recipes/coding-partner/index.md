---
title: Coding Partner
icon: vscode-icons:file-type-markdown
---

# Coding Partner

This recipe builds a small custom coding assistant.

The point is not to expose an agent loop. The point is to show how a normal Axon agent is authored: `src/` defines who the agent is and how tasks are framed, `server/` defines how the world reaches the agent, `data/` holds durable reference material, `modules/` adds packaged capabilities, and policy constrains what the agent may do.

The agent handles interactive chat and headless API review.

## Folder structure

```bash
coding-partner/
├── data/
│   └── knowledge/
│       └── repo-guidelines.md
├── modules/
│   └── typescript/
├── server/
│   └── api/
│       ├── chat.post.ts
│       └── repo-review.post.ts
├── src/
│   ├── prompts/
│   │   ├── components/
│   │   │   ├── coding-standards.vue
│   │   │   ├── identity.vue
│   │   │   └── personality.vue
│   │   ├── chat-context.vue
│   │   ├── command-approval.vue
│   │   └── repo-review.vue
│   ├── tools/
│   │   └── github.ts
│   └── boot.vue
└── axon.config.ts
```

## How it works

The chat route handles interactive conversation. It renders `chat-context.vue` with the current request and calls `axon.stream()` — the agent carries context across messages for the life of the session.

The review route runs a stateless task. It renders `repo-review.vue` with the target repo and branch, then calls `axon.stream()` with no thread — each review is independent.

Both routes use the same agent identity and tools. The route context (task scope, policy constraints) changes the agent's behavior for that invocation.

## What to read first

Start with `src/boot.vue` to see how identity and operating rules are composed, then
read `server/api/chat.post.ts` to see how the TUI path prepares a task. Per-file
walkthroughs are coming to this recipe.
