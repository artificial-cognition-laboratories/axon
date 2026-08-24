---
title: The Boundary
---

# The Boundary

An agent is a complete thing with one way in and one way out.

**In:** text, audio, images — stimuli.
**Out:** text, audio, images, and actions.

That is the whole surface. It does not widen because the caller happens to be another
agent rather than a person.

## What this rules out

None of these exist, and none of them will:

- subscribing to another agent's hooks
- reading another agent's session or memory
- calling another agent's tools directly
- waiting on another agent's boot, or booting in a required order
- sharing a policy, a capsule, or a context between agents

Each looks like a small convenience. Each turns two independent agents into one tangled
thing that only works in a particular arrangement.

## Why the constraint is worth it

**Agents stay whole.** Install an agent, run it, and it works — because it never assumed
what else was running. That is what makes agents publishable and replaceable, and it
evaporates the moment one depends on another's internals.

**Location stops mattering.** If the only way in is a stimulus, it makes no difference
whether the agent is in this process, elsewhere on your laptop, or deployed behind a URL.
Moving one to the cloud is a change of address, not a rewrite.

| Where | How you reach it |
|---|---|
| Booted by your script | the handle from `Axon()` |
| Running elsewhere on this machine | its local HTTP address |
| Deployed | its URL, with a connect token |

**Boot order stops mattering.** Hooks fire during boot, before other agents exist — so
cross-agent subscriptions aren't merely inadvisable, they're often impossible to satisfy.
You do not synchronise a computer's startup with its monitor's; you assume both come up,
then use them.

## The escape hatch

One, deliberately narrow: **a tool can do anything.**

If an agent needs a capability the protocol doesn't cover, a tool author can build it —
including one that spawns or drives another agent. That stays contained, because it is one
agent's implementation detail rather than a platform concept. Anything not expressible
through stimuli is expressible in a tool, and the cost is that you own it.

## When two agents shouldn't be two agents

Sometimes the coupling you want means the line is in the wrong place. The test:

**Could this agent be published on its own, and would anyone else install it?**

If yes, it is a real agent and talks to others through the protocol. If no — if it exists
solely to serve one caller that knows its internals — it is a *part* of that agent. Make it
a tool, a module, or a capsule-side subagent. Those are designed for tight coupling.

Reaching for cross-agent hooks usually means this question was answered wrong.

## How agents talk

**Request** — send a stimulus and wait. An HTTP call to another agent's route, or
`request()` through a handle you booted.

**Emission** — send and move on. Whether the receiver acts on it is a property of its
cognition, not of the transport.

Both go through the front door. Neither requires the sender to know anything about the
receiver except its address.

---

Next: [Agents in Code](/docs/v2/fleet/code) — the API this shape produces.
