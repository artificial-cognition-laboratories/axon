---
title: The Runtime Loop
---

# The Runtime Loop

When you call `axon.request()` or `axon.stream()`, the agent needs to think — assemble
context, call inference, execute what the model asked for, decide when it's done. That
cycle is the runtime loop, and it's the part of the platform you never write.

## One tick

Every iteration of the loop does the same four things:

1. **Assemble** — the agent's current state — history, loaded prompts, tool
   declarations, live process snapshots — is rendered into an [AIR](/docs/v2/concepts/air-format)
   context window.
2. **Invoke** — the context goes to the configured [engine](/docs/v2/agent/runtime/engines).
   Text streams out to you; `<typescript>` blocks are collected.
3. **Act** — collected blocks execute in the capsule, under policy. Results are
   committed to the session log.
4. **Decide** — the loop ends only when the model has explicitly signalled completion
   *and* has seen the results of everything it ran. Otherwise, tick again — the next
   context window includes what just happened.

That last rule matters: an agent never ends a task without witnessing its own results.
No inferred stopping, no abandoned tool calls.

## What you don't configure

None of this is exposed as configuration. Iteration limits, context compression, stop
detection — these are engineering problems with improving solutions, not decisions that
should vary per agent. Exposing them as config would make every improvement a
migration; keeping them managed means every agent gets the improvement automatically,
on the next runtime version.

Distinguishing "task complete" from "waiting for input" from "stuck" is one of the
harder problems in agent design. Getting it wrong produces agents that exit early or
spin forever. It's handled — and when the handling improves, you change nothing.

## Engines are inference, not cognition

The engine is the model the loop calls in step 2 — nothing more. The loop, the context
format, the dispatch are identical whether inference comes from Axon Cloud, your
OpenRouter key, or Ollama on your own hardware. Swapping engines changes how the agent
thinks, never how it works.

## Everything is on the record

Every tick writes to the session trace in `data/sessions/` — the context that was
assembled, the output that came back, the code that ran, the results. When the agent
does something unexpected, the trace shows exactly what the model saw and did.

---

**[AIR Format](/docs/v2/concepts/air-format)** — the context window structure, tick by tick.

**[Agent Output](/docs/v2/concepts/agent-output)** — the output side: why the agent
speaks TypeScript and how blocks execute.
