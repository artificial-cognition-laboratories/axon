---
title: The Axon Runtime
---

# The Axon Runtime

Every agent framework eventually forces the same decisions: how do you assemble the
context window? How do you decide when the agent should stop? What happens when a tool
call fails? How do you persist session state across requests? How do you enforce what the
agent is and isn't allowed to do?

In most frameworks, those decisions are yours. You read the docs, pick a strategy, and
implement it. Then you do it again for the next agent.

Axon makes those decisions once. The result is the managed runtime — the infrastructure
layer that every Axon agent runs on, regardless of what the agent does.

## The boundary

The boundary is `axon.request()` and `axon.stream()`.

On your side: which prompts to load, what policy to apply for this invocation. On Axon's
side: everything else.

```ts
const { stream } = axon.stream({
    prompt: [session, task],          // you assembled this
    policy: { fs: { write: false } }, // you narrowed this
})

for await (const entry of stream) {
    // the runtime ran the loop, dispatched tools, managed context
    // you receive structured output entries
}
```

You don't call the model directly. You don't manage the context window. You don't
implement retry logic or handle partial tool call responses. You stream entries.

## What Axon owns

**Context assembly** — Axon formats the system prompt, prior conversation history, loaded
prompts, and tool declarations into a context window. How it balances these against the
model's context limit, when it compresses, how it prioritises — handled automatically.

**Tool dispatch** — when the model decides to call a tool, Axon routes the call to the
capsule subprocess, executes it under the active policy, and feeds the result back into
the loop. You don't orchestrate this. You don't poll for results.

**Loop control** — the agent runs until it reaches a natural stopping point or a
configured stop condition fires. You don't implement a loop. You don't check whether
the agent is done.

**Stop conditions** — the runtime detects when the agent has completed its task and
terminates the loop cleanly. You consume the output stream; you don't monitor for
completion signals.

**Session persistence** — every session is written to `data/sessions/` as a JSONL trace,
the durable record of everything the agent did. This is automatic. You don't manage it
and you don't call any persistence API.

**Kernel enforcement** — agent code runs in the capsule, an isolated subprocess with its
own process boundary. The kernel enforces the policy you declare — which files can be read or
written, which processes can be spawned, which network calls can be made. The agent
process has no direct access to any of these primitives. Policy violations are rejected
before the function runs, not after.

## Why this matters

The same agent source works in every environment without modification. The runtime
adapts to the environment; your code does not. The `src/` you write on your laptop is
the same `src/` that runs in production.

When Axon ships a better context assembly strategy, a more efficient compression model,
or a smarter stop condition, your agent gets it. You update a package version, not an
implementation. The infrastructure is maintained for you.

## What you still own

The runtime manages execution. It does not write your agent.

| Yours | Runtime's |
|---|---|
| Agent identity (`boot.vue`) | Context window assembly |
| Tools — what the agent can do | Tool dispatch and retry |
| Prompts — what context it receives | Loop control and stop conditions |
| Scripts — how work is orchestrated | Session persistence |
| Policy — what it's allowed to do | Capsule process isolation |
| Routes — how it's exposed over HTTP | Engine API management |

The line is intentional. Axon owns the hard infrastructure problems that are the same for
every agent. You own the things that make this agent distinct.

## Engines are swappable

The runtime is model-agnostic. One line in `axon.config.ts` selects the inference
source; the loop, tools, and policy don't change. [Engines](/docs/v2/agent/runtime/engines)
covers the choice — managed, bring-your-own, or fully local.

---

**[State & Memory](/docs/v2/concepts/state-model)** — the four layers of state behind
the runtime behaviour you just read about.

**[Agent Structure](/docs/v2/agent/folder)** — the folder reference. Every file, what
it does, what Axon does with it at boot and runtime.

**[The Runtime Loop](/docs/v2/concepts/runtime-loop)** — what one tick of the loop
actually does, and why none of it is configuration.
