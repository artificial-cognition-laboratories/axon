---
title: Workspace Agents
---

# Workspace Agents

Clone the repo. Open Axon. The agent already knows where you are.

Not because someone configured it. Because the team committed a `.agents/` folder — tools
that call the project's APIs, prompts that hydrate sprint state, scripts that automate the
workflows senior engineers carry in their heads, knowledge files that encode the decisions
that would otherwise require a two-hour onboarding call.

A new teammate picks all of it up automatically. No setup. No documentation to find. No
one to ask.

```bash
my-repo/
├── .agents/
│   ├── data/
│   │   └── knowledge/  # architecture docs, contracts, runbooks
│   ├── modules/        # shared installed modules
│   ├── prompts/        # context templates — workspace:name
│   ├── scripts/        # team automations — workspace:name
│   └── tools/          # project-specific callables — workspace.*
├── src/
└── package.json
```

## What this actually enables

The institutional memory problem is hard. Knowledge accumulates in people's heads, degrades
as people leave, and never makes it into the wiki — or if it does, nobody reads it. `.agents/`
is the first mechanism that makes that knowledge executable rather than just documented.

The knowledge layer is underrated. Architecture decisions, API contracts, incident runbooks —
in `data/knowledge/` these aren't docs nobody reads. They're the agent's grounding context.
When something breaks at 2am, the agent doesn't just know the runbook exists — it uses it.

The scripts layer is where it compounds. Tools and prompts are capabilities. Scripts are
**workflows** — the things senior engineers do that junior engineers can't yet:

```bash
.agents/
├── data/
│   └── knowledge/
│       ├── decisions/
│       ├── api-contracts.md
│       └── architecture.md
├── prompts/
│   ├── conventions.md  # codebase style and conventions
│   ├── runbook.md      # incident response steps
│   └── session.vue     # hydrates current sprint state
├── scripts/
│   ├── close-plan.ts   # sprint close automation
│   ├── scout.ts        # daily codebase scan
│   └── triage.ts       # issue triage workflow
└── tools/
    ├── deploy.ts       # deployment tooling for this project
    ├── github.ts       # repo-specific GitHub helpers
    └── kanban.ts       # project task management
```

Commit `triage.ts` to `.agents/scripts/` and triage is now team infrastructure. Anyone can
run it. The agent can run it. It runs the same way every time.

## It versions with the codebase

This is the structural insight. `.agents/` is committed source. That means:

- The `main` branch agent knows about production. The `feature/payments` branch agent knows
  about the payments work in progress.
- A PR can ship a new workspace script alongside the feature it automates. The automation
  and the code land together, reviewed together, rolled back together.
- When a convention changes, the prompt that encodes it changes in the same commit.

There's no separate "update the agent" step. The agent stays current because it's part of
the codebase.

## Discovery

Axon walks upward from the agent's working directory until it finds a `.agents/` folder.
The first one found is used. This mirrors how `tsconfig.json` and `package.json` resolution
works — no path to configure, no registration step. Run an agent from anywhere inside the
repo and it finds the workspace layer automatically.

## Opting in

Workspace resources are not loaded automatically. Each agent opts in explicitly in
`axon.config.ts`:

```ts
export default defineAgent({
    workspace: true,
})
```

With `workspace: true`, the agent picks up everything in `.agents/`. If no `.agents/`
folder exists, the flag is silently ignored. If the folder exists but an agent doesn't set
the flag, nothing is loaded — the agent is unaffected.

## What gets loaded

| Resource | Namespace | What it means |
|---|---|---|
| `tools/` | `workspace.*` | Exported functions callable by the agent and in scripts |
| `prompts/` | `workspace:name` | Context templates loadable via `axon.prompt("workspace:triage")` |
| `scripts/` | `workspace:name` | Automations runnable via `axon run workspace:scout` |
| `modules/` | — | Module source loaded and registered as if agent-installed |
| `data/knowledge/` | — | Files on disk, readable by the agent when directed |

Nothing is injected into context automatically. Tools become callable. Prompts and scripts
become invocable by name. Knowledge files sit on disk for the agent to read when a prompt
or script points it there.

## Namespacing

Workspace capabilities are namespaced to prevent collisions with the agent's own source.

```ts
// agent's own tool
const prs = await axon.tools.github.listOpenPrs()

// workspace tool — same name, different namespace
const tasks = await axon.tools.workspace.kanban.list()
```

```ts
// agent's own prompt
const agentContext     = await axon.prompt("session")

// workspace prompt
const workspaceContext = await axon.prompt("workspace:session")
```

An agent's own capabilities always take precedence. Workspace capabilities extend the
surface without overwriting anything.

## What .agents/ is not

`.agents/` has no `axon.config.ts`. It is not an agent. It has no identity, no engine
configuration, no policy, no sessions, no deployment. The parent agent remains fully
authoritative over all of those things.

A workspace tool runs inside the parent agent's capsule, subject to the parent agent's
policy. If the base policy doesn't allow network calls to a particular host, a workspace
tool that tries to reach it will be blocked — exactly the same as if the agent's own tool
tried it. The workspace layer contributes capabilities; it never gains authority.
