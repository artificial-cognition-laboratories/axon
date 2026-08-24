---
title: Working with Agents
---

# Working with Agents

Most of these docs describe one agent. This section is about more than one — running them
together, how they talk, and how you debug a system made of several minds.

```ts
// review.axon.ts
const { barry, checker } = await Fleet({
    barry:   "../barry",
    checker: "../checker",
})

const review  = await barry.request("review the changes on this branch")
const verdict = await checker.request(`is this review fair?\n\n${review.text}`)

console.log(verdict.text)
```

Two agents, two policies, two toolsets, two isolated memories, in one ordinary TypeScript
file.

## Agents are whole, not parts

Everything here follows from one rule: **an agent is a complete, bounded thing, and the
only way in or out is the stimulus protocol.**

Agents never reach into each other — no subscribing to another's hooks, no reading its
session, no borrowing its tools. They boot independently and talk once they are up, the
way two machines on a network do.

That constraint is what keeps every agent independently installable, deployable, and
replaceable. [The Boundary](/docs/v2/fleet/boundary) makes the case in full.

## Three scales

**A script boots them.** A `*.axon.ts` file constructs the agents it needs, composes them
in plain TypeScript, and exits. The scratch form — start here.

**An agent orchestrates them.** When a workflow is worth publishing, deploying, or
scheduling, it becomes an agent whose job is coordinating other agents.

**They run as a fleet.** Several agents live on your machine at once, each with its own
address, finding each other through the running directory.

All three are the same primitive: `Axon()` boots an agent and hands you a complete handle.
What you build on top — a pipeline, a pool, a graph engine — is yours to write.

## Where to go next

This section has three parts. **Composition** is agents in code. **Management** is agents
on your machine. **Debugging** is one run, in detail.

### Composition

**[The Boundary](/docs/v2/fleet/boundary)** — why agents only talk through stimuli.

**[Agents in Code](/docs/v2/fleet/code)** — `Axon()`, `Fleet()`, and the script they live
in.

**[Lifecycle](/docs/v2/fleet/lifecycle)** — how a reference becomes a running agent, and
when it stops.

### Management

**[Managing Agents](/docs/v2/fleet/management)** — the editor surface: what can do work,
and what needs doing.

**[Running Instances](/docs/v2/fleet/management/instances)** — everything alive on the
machine, whoever started it.

**[Assets](/docs/v2/fleet/management/assets)** — agents and prompts, as things you
dispatch.

**[Jobs](/docs/v2/fleet/management/jobs)** — work as markdown files in your repo.

### Debugging

**[Debugging in Code](/docs/v2/fleet/debugging)** — session IDs, live entries, isolating
one agent.

**[The Console](/docs/v2/fleet/debugging/console)** — four panes over one run, live or
finished.

**[The Engine Pane](/docs/v2/fleet/debugging/engine)** — the exact document the model
received.

**[Trace & Events](/docs/v2/fleet/debugging/trace)** — where the time went, and what
policy stopped.

---

Next: [The Boundary](/docs/v2/fleet/boundary) — the rule everything else follows from.
