---
title: Debugging in Code
---

# Debugging in Code

Debugging one agent is reading its trace. Debugging several is the same skill applied
N times, plus one new problem: working out which trace to read.

This page is what you can do from inside the script. The pages after it are the
[Console](/docs/v2/fleet/debugging/console) — the same traces, read properly.

## Every agent traces itself

Each agent writes its own session to its own `data/sessions/` as a JSONL trace — every
request, every tool call, every result, every error. Three agents in a script produce
three traces in three folders.

That is a consequence of the boundary, not an oversight. Agents don't share memory, so
they don't share a log. Each trace is complete and readable on its own, which means you
can debug one agent's behaviour without untangling it from the others.

```ts
const { barry } = await Fleet({ barry: "../barry" })

console.log(barry.session.id)   // which trace to read
```

Print the session IDs at the top of any multi-agent script. It costs one line and it is
the difference between finding the right file in seconds and grepping by timestamp.

## Watching live

`session.entries` is the live log — readable while the agent is working:

```ts
const before = barry.session.entries.length
await barry.request("audit the repo")
const produced = barry.session.entries.slice(before)
```

`on()` subscribes to what the agent emits as it emits it, which is how you build a live
view over several agents at once:

```ts
for (const [name, agent] of Object.entries({ barry, checker })) {
    agent.on("text", ({ content }) => process.stdout.write(`[${name}] ${content}`))
}
```

Prefixing by name is the cheap version of the correlated view — enough to follow two
agents interleaving in a terminal.

## Reading the trace

The trace records what the model actually saw and did, tick by tick — the assembled
context, the output, the code that ran, the results. When an agent does something
unexpected, this is where the answer is, and it is usually in the context rather than
the response: the agent did the right thing with the wrong information.

Entry types are documented under [Entries](/docs/v2/api/thread/index). The ones you
reach for most: `axon:agent:message` for what it said, `capsule:stdin` and
`capsule:stdout` for what it ran, `capsule:denied` for what policy stopped.

## Which agent is wrong?

With several agents, the first question is where the failure entered. A pipeline makes
this tractable, because each stage's input is a value in your script:

```ts
const findings = await scout.request("find every caller")
console.log("--- findings ---\n", findings.text)   // check before passing on

const plan = await planner.request(`plan a refactor.\n\n${findings.text}`)
```

Most multi-agent bugs are not agent bugs. They are prompt bugs at a handoff — one agent
produced something reasonable, and the next agent received it without the context needed
to interpret it. Printing what crosses each boundary finds this faster than reading
either trace.

## Isolating one agent

Because agents are independent, you can run one on its own with the same input and see
whether it misbehaves outside the composition:

```bash
axon                              # boot it in the TUI, talk to it directly
axon run review --file src/x.ts   # run its own script headlessly
```

If it behaves alone and misbehaves in the fleet, the problem is what you handed it. If
it misbehaves alone, it is an agent problem — debug it as one agent.

## Determinism

Multi-agent runs vary between executions, which makes a bug that appeared once hard to
reproduce. Pin what you can:

**Use the mock engine** for the parts under test. It makes agent responses deterministic,
so a failing composition fails the same way twice. See
[Testing](/docs/v2/agent/testing).

**Pin registry versions.** An unpinned fleet member can change under you between runs;
`@arclabs/linter@1.2.0` cannot.

**Keep handoffs in variables.** Text passed between agents through a named variable is
inspectable, loggable, and replayable. Inline template strings are none of those.

## Known gap: no unified run view

There is no single artifact representing "this run across all its agents." Traces are
per-agent, and joining them is still done by hand.

Each one is complete on its own, and the [Console](/docs/v2/fleet/debugging/console)
reads any of them — live or finished — so the missing piece is correlation across
several, not depth within one. Until it exists, printing session IDs and prefixing live
output is the practical substitute.

---

Next: [The Console](/docs/v2/fleet/debugging/console) — reading a trace without reading
JSONL.
