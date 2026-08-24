---
title: Agents in Code
---

# Agents in Code

A file ending `.axon.ts` is a global script — an ordinary TypeScript program that boots
its own agents. It lives wherever you put it: a repo root, a scratch directory, `~/bin`.

```ts
// ~/scripts/standup.axon.ts
const { axon: barry } = await Axon("~/agents/barry")

const summary = await barry.request("summarise yesterday's commits")
console.log(summary.text)
```

```bash
axon exec standup.axon.ts
```

No agent folder, no config, no imports. `Axon` and `Fleet` are globals that
[`axon exec`](/docs/v2/cli/exec) binds for the run — a script that must run from anywhere
can't rely on a `node_modules` being nearby.

## The handle

`Axon()` resolves an agent, boots it, and returns its runtime. `axon` is the handle;
rename it on the way out so a script with three agents reads clearly.

```ts
const { axon: barry } = await Axon("../barry")
const { axon: dave }  = await Axon("../dave")
```

The handle is complete — anything you can do to a running agent, you can do here. It is
the same one an agent-scoped script has as its `axon` global.

```ts
await barry.request(input)       // run to completion → { text, entries }
barry.stream(input)              // live entries as they arrive
await barry.prompt(name, vars)   // render one of this agent's prompts
await barry.tools.ns.fn(args)    // call one of this agent's tools
barry.session.id                 // this instance's trace, and its correlation key
barry.on(type, handler)          // observe what it emits
await barry.update(blueprint)    // hot-reload it
await barry.shutdown()           // tear it down
```

That completeness is the point: a pipeline, a pool, a state machine or a graph engine is
something you write over this handle, not something the platform has to provide.

Two handles share nothing — separate tools, policy, session, capsule, and memory.
`barry.prompt("review")` and `dave.prompt("review")` are different files. Results cross
only when you put them in a prompt.

## Fleet

`Fleet()` boots several at once, named:

```ts
const { barry, checker, zeno } = await Fleet({
    barry:   "../barry",
    checker: "../checker",
    zeno:    "@axon/zeno",
})
```

It resolves every reference before booting any of them — so a typo in the fourth name
fails before the first capsule exists — then boots them together, costing the slowest
agent rather than the sum.

It is a convenience, not a layer: `Promise.all` over `Axon()` calls with the names
attached. Use it when the cast is known at the top of the script. Reach for `Axon()`
directly when it isn't — agents chosen at runtime, booted in a loop, or held by something
you built.

## One handle is one conversation

Consecutive calls share full context:

```ts
await barry.request("we're refactoring the auth module")
await barry.request("start with the token parser")   // barry remembers
```

There is no sub-context inside an instance — no threads, no named conversations.
Isolation comes from booting another instance, which is a real boundary rather than a
partition inside one. To reset an agent, shut it down and boot it again.

Two names may point at one folder, and sometimes that is what you want — two independent
conversations with the same agent. It boots twice, which is cheap for a request-response
agent and the way to fan work out. Two caveats: **module setup runs per instance**, so an
agent holding an external connection opens two of them, and **continuous-mode agents are
not cheap** — one running a live cognitive loop works whether or not you are talking to
it.

## Knowing when to split

Two questions decide whether work belongs to one agent or several.

**Does the second step need to be uncontaminated by the first?**

```ts
const review = await barry.request("review the changes on this branch")

const verdict = await checker.request(
    `A reviewer produced the following. Is it fair, specific, and actionable?\n\n${review.text}`,
)
```

The check is worth something precisely because `checker` never saw the diff, the tool
calls, or the reasoning — only the output. An agent grading its own work grades a
conclusion it is already committed to.

**Do the steps need different permissions or different tools?** An agent that reads the
codebase and an agent that opens pull requests should not be the same agent. Policy is
per-agent, so splitting is how you narrow what each part can reach.

If neither applies, one agent and consecutive calls is the simpler program — and it keeps
context across the steps, which is usually what you want.

## Independent work runs at once

```ts
const [sec, prf] = await Promise.all([
    security.request("audit this service for vulnerabilities"),
    perf.request("profile this service and find the hot paths"),
])

const plan = await lead.request(
    `Two audits completed.\n\nSecurity:\n${sec.text}\n\nPerformance:\n${prf.text}\n\n` +
    `Produce a single prioritised plan. Call out anything where the two conflict.`,
)
```

`lead` sees two finished analyses rather than two agents' worth of intermediate work,
which is what makes the synthesis useful rather than overwhelming.

An agent is not obligatory, either. Fetch and transform with plain TypeScript; bring in an
agent for the step that needs judgment, and exit before booting anything when there is
nothing to do.

## Arguments

Everything after the file arrives as `process.argv`:

```bash
axon exec review.axon.ts --file src/index.ts
```

There is no `defineArgs` — that belongs to agent-scoped scripts, where the runtime parses
arguments before invoking them. A global script is started by a shell and reads its
arguments like one.

## Agent-scoped scripts

A script in `src/scripts/` is the other kind. It runs *inside* an agent that is already
booted, so it gets `axon`, `args` and its tools as globals and owns no lifetime.

```ts
// src/scripts/review.ts — inside an agent
const content = await axon.tools.fs.readFile(file)
const { stream } = axon.stream({ prompt: await axon.prompt("review", { file, content }) })
```

The bodies are otherwise identical — `barry` is the same handle with a name you chose. The
question that picks between them is one sentence: **does this need more than one agent?**

`await Axon()` with no argument works in both. In a global script it walks up from the
file and boots what it finds; inside `src/scripts/` it returns the already-running
instance. Useful when a script wants boot to be explicit — do work first, exit early, and
only then pay for an agent.

---

Next: [Lifecycle](/docs/v2/fleet/lifecycle) — resolution, teardown, and what survives.
