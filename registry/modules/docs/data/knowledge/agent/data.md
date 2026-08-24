---
title: data/
icon: vscode-icons:default-folder
---

# data/

`data/` is the durable storage root for everything that grows, changes, or gets written
during execution — material the agent accumulates over time rather than authored behavior.

```bash
data/
├── knowledge/      # reference material the agent reads
├── modules/        # module-managed persistent state
└── workspace/      # scratch space: cloned repos, working trees, temp output

.agent/data/        # written by the runtime, not by you
├── sessions/       # thread history — written by Axon
├── state/          # persistent working state across sessions
└── sensory/        # dense sense streams, when the agent has sensors
```

Two roots, and the line between them is who wrote the file. **`data/` is yours** —
you author it, you commit it, it is part of what the agent is. **`.agent/data/` is the
runtime's** — a record of what the agent did, generated rather than written, and
gitignored along with the rest of `.agent/`.

That is why `sessions/` and `state/` moved out of `data/` and `knowledge/` did not: a
session log is output, a knowledge file is input. Everything under `.agent/` can be
deleted and the agent is still the same agent; delete `data/knowledge/` and it is not.

Keep the distinction clean: if a file tells the agent who it is or how to behave, it
belongs in `src/`. If it is durable material the agent consults or writes during work, it
belongs in `data/`. If the runtime produced it, you do not place it at all.

## AXON_HOME

Every capsule gets `AXON_HOME` injected automatically — the absolute path to the agent's
own directory, the folder holding `axon.config.ts`. Use it to construct stable paths from
anywhere in your tools or scripts, regardless of what working directory the capsule
happens to be in.

```ts
const knowledgePath = `${process.env.AXON_HOME}/data/knowledge`
const workspacePath = `${process.env.AXON_HOME}/data/workspace`
const statePath = `${process.env.AXON_HOME}/.agent/data/state`
```

This means agents always know where home is — in local dev, in deployment, across reboots.

## knowledge/

Reference material the agent can read. Commit anything here that should be available
across sessions: architecture docs, API contracts, codebase conventions, runbooks,
decision logs.

```bash
data/knowledge/
├── decisions/
│   ├── 2025-05-auth-flow.md
│   └── 2025-06-db-schema.md
├── api-contracts.md
├── architecture.md
└── conventions.md
```

The agent doesn't automatically read everything in `knowledge/` — a prompt or script
directs it to read specific files when relevant. The value is having authoritative
reference material on disk, in the repo, versioned with the codebase.

In the `.agents/` workspace layer, `data/knowledge/` is the canonical location for
project-level reference material shared across all agents in the repo.

## .agent/data/sessions/

Written entirely by Axon. Thread logs, conversation history, and continuity data live
here, organised by session and thread ID.

```bash
.agent/data/sessions/
└── <session-id>.jsonl
```

Don't write to `sessions/` manually. Don't depend on its internal structure in your code.
Axon manages it — the format may change between versions. Its position under `.agent/`
is the same statement: this is generated output, not part of your source.

## .agent/data/state/

Persistent working state the agent writes and reads across sessions. Use this for anything
that needs to survive a reboot but isn't reference material — scan results, open proposals,
sync cursors, computed summaries.

```bash
.agent/data/state/
└── <cognet>/
    ├── coverage.json       # last known coverage snapshot
    └── proposals.json      # open proposals awaiting human review
```

Unlike `sessions/` (managed by Axon) and `knowledge/` (written by humans), `state/` is
owned by the agent. It reads and writes it freely as part of its work. It lives under
`.agent/` because the agent produced it — but unlike the rest of that directory, deleting
it costs the agent its memory, so it is the one part of the frame worth backing up.

The human can inspect it at any time — keep it in plain JSON or Markdown so it's readable
without tooling.

## workspace/

The agent's scratch space. Clone repos here, check out working trees, write intermediate
output, run builds. Anything that needs a real filesystem path during a work session.

```bash
data/workspace/
├── audit-output/       # intermediate files from a multi-step run
└── my-target-repo/     # cloned for the current task
```

Think of it as the agent's equivalent of a developer's `~/projects/` — a place to put
things being actively worked on. Use `AXON_HOME` to anchor paths here:

```ts
const repoPath = `${process.env.AXON_HOME}/data/workspace/my-target-repo`
await process.run(`git clone https://github.com/org/repo ${repoPath}`)
```

`workspace/` is not committed. It's ephemeral relative to `data/` as a whole — the agent
can treat it as a temp dir that persists across sessions but is safe to delete and
regenerate. Don't put anything irreplaceable here; put irreplaceable output in `state/`
or `knowledge/`.

## modules/

Module-managed persistent state, namespaced by module name. If an installed module needs
to persist data — a cache, a sync cursor, indexed content — it writes here.

```bash
data/modules/
└── @axon/
    └── github/
        └── webhook-cursor.json
```

Each module owns its subdirectory. Don't write to another module's namespace.

## Persistence in deployment

In local agents, both roots are files on disk. In deployed agents on Axon Cloud, they are
backed by durable storage — every write the agent makes inside `data/` or `.agent/data/`
persists across restarts and redeployments.

Self-hosted deployments need to mount persistent storage at **both** paths to get the same
behaviour. Mounting only `data/` is the easy mistake to make and the expensive one: the
agent keeps its knowledge and loses its memory, coming back after every restart with no
session history and no state.

Anything written outside those two roots during execution is ephemeral in deployed
environments. Write durable output to `data/`; let the runtime write `.agent/data/`.
