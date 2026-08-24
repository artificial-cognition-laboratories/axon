---
title: src/
icon: vscode-icons:folder-type-src
---

# src/

`src/` is the agent's brain. It contains the standing boot prompt that defines who the
agent is, tools the agent can call, prompts it can load as context, and scripts that
orchestrate work.

```bash
src/
├── prompts/          # reusable context templates
│   └── components/   # shared Vue fragments, auto-imported
├── scripts/          # TypeScript automations
├── tools/            # async functions → agent-callable tools
└── boot.vue          # standing system prompt
```

Everything in `src/` is discovered by filename — no registration, no config.

## The parts

**`boot.vue`** defines the agent's identity, working practices, and standing orientation.
Keep it stable — request-specific context belongs in prompts, not here. In local
development it hot-reloads for future work without rewriting existing thread history.

**`tools/`** — every exported async function in a `.ts` file becomes a tool the agent
can call. The filename is the namespace: `tools/github.ts` → `github.*`. JSDoc becomes
the agent's description of the function.

**`prompts/`** — named context templates loaded at invocation time. Static (`.md`) for
stable instructions, dynamic (`.vue`) for instructions that incorporate live data fetched
at render time.

**`scripts/`** — the primary authoring unit. TypeScript files that load prompts, call
the agent, process results, and do follow-on work. Run from the CLI, the TUI palette,
HTTP routes, or programmatically.

**`prompts/components/`** — reusable Vue fragments auto-imported globally into `boot.vue`
and all dynamic prompts. No import statements needed.
