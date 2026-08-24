---
title: The Managed Runtime
---

# The Managed Runtime

Every agent framework forces the same decisions: how do you assemble the context window?
When does the agent stop? What happens when a tool call fails? How do you persist session
state? How do you enforce what the agent is and isn't allowed to do?

In most frameworks, those decisions are yours to implement — once per agent, forever.

Axon makes them once. The result is the managed runtime: the infrastructure layer every
Axon agent runs on, regardless of what the agent does.

The boundary is a single call:

```ts
const { stream } = axon.stream({
    prompt: [session, task],
})
```

Everything past that call — context assembly, tool dispatch, loop control, session
persistence, capsule enforcement — is Axon's concern. You stream entries and process them.

When Axon ships a better context strategy or a more capable engine, your agent gets it.
You update a package version, not an implementation.

For the full breakdown of what Axon owns, what you own, and how the boundary works in
practice, see [Agent](/docs/v2/agent).
