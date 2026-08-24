---
title: axon exec
---

# axon exec

Run a global script — a `*.axon.ts` file that boots its own agents.

```bash
axon exec ./review.axon.ts
axon exec ~/scripts/standup.axon.ts --since yesterday
```

The file runs, and every agent it booted is shut down when it finishes. No agent folder
is required, and the script does not have to live inside a project.

## Why not `axon run`

[`axon run`](/docs/v2/cli/run) is agent-first: `-a` names one agent, and `-p`, `-s` and
`--text` all resolve against it. A global script names its own agents in its own code,
so there is nothing for `-a` to point at.

Keeping them apart means neither command has flags that apply to only some of its
inputs:

```bash
axon run  -a barry -s close-plan   # this agent, its script
axon exec ./close-plan.axon.ts     # a program; it picks its agents
```

`axon exec` takes no `-a` deliberately. A script that wants an agent calls `Axon()` —
handing it an ambient one it never asked for is exactly what the global-script form
exists to avoid.

## Arguments

Everything after the file reaches the script as `process.argv`:

```bash
axon exec ./review.axon.ts --file src/index.ts --verbose
```

There is no `defineArgs` here — that belongs to agent-scoped scripts, where the runtime
parses arguments before invoking them. A global script is started by a shell and reads
its arguments like a shell program does.

## `Axon` and `Fleet` are in scope

Both are bound for the run, so nothing is imported:

```ts
// standup.axon.ts
const { barry } = await Fleet({ barry: "~/agents/barry" })

const summary = await barry.request("summarise yesterday's commits")
console.log(summary.text)
```

This is what lets a global script live anywhere — a repo root, `~/bin`, a scratch
directory — none of which has a `node_modules` to resolve an import from.

## Relative references

A relative agent reference inside the script resolves against **the script's own
directory**, not the directory you invoked from:

```bash
cd ~/projects/api
axon exec ~/scripts/standup.axon.ts    # "../barry" inside means ~/barry
```

This is what makes a script portable: it keeps working wherever you run it from.

## Lifetime

```
axon exec review.axon.ts
  │
  ├─ resolve every reference     ← fails here if an agent is missing
  ├─ boot                        ← capsules start, modules connect
  ├─ run the script              ← your code
  └─ shut everything down        ← always, including on failure
```

Teardown covers every agent the script booted, including when the script throws and
including agents booted before the failure. Shutdown is error-isolated — one agent
failing to close never strands the others — and session logs are flushed regardless, so
a crashed run still leaves a complete trace per agent.

A failing script fails the command: the exit status reflects what happened.

## See also

- [Agents in Code](/docs/v2/fleet/code) — writing one, and what `Axon()` gives you
- [Lifecycle](/docs/v2/fleet/lifecycle) — boot, teardown, and what survives
