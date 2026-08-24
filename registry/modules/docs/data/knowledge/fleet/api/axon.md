---
title: Axon()
---

# Axon()

Boots one agent and returns its runtime. A global in every `*.axon.ts` script —
`axon exec` binds it for the run, so nothing is imported.

```ts
const { axon: barry } = await Axon("../barry")
```

## Signature

```ts
function Axon(ref?: string): Promise<AxonRuntime>
```

**`ref`** — an agent reference: a path (`"../barry"`, `"~/agents/dave"`), a bare name
resolved from watch paths (`"scout"`), or a registry package (`"@axon/zeno"`,
`"@axon/zeno@1.4.0"`). See [Lifecycle](/docs/v2/fleet/lifecycle).

Omitted, it walks up from the script and boots the agent folder it finds. Throws if
there is none.

## The returned runtime

```ts
const runtime = await Axon("../barry")

runtime.axon        // the agent handle — what you normally want
runtime.blueprint   // the resolved agent configuration
runtime.session     // the session log
runtime.shutdown()  // teardown (the CLI calls this for you)
```

Destructure the handle on the way out and name it for this script:

```ts
const { axon: barry } = await Axon("../barry")
```

## The handle

`axon` is the same handle an agent-scoped script has as a global.

```ts
await barry.request(input)       // run to completion → { text, entries }
barry.stream(input)              // live stream → { stream }
await barry.prompt(name, data)   // render one of this agent's prompts
barry.tools.ns.fn(args)          // call one of this agent's tools
barry.session.entries            // this agent's entry log
await barry.update(partial)      // hot-reload this agent
```

Full reference: [axon handle](/docs/v2/api).

## Notes

**Boot is not free.** A capsule subprocess starts, a session opens, and every declared
module runs its setup. Boot once and reuse the handle.

**Instances are independent.** Booting the same agent twice gives two conversations —
and runs its module setup twice. For several agents at once, use
[`Fleet()`](/docs/v2/fleet/api/fleet).

**Context is continuous.** Consecutive calls on one handle share full history. One
agent is one conversation for the life of the handle.

**Shutdown is the CLI's.** `axon run` tears down everything the script booted, including
on failure. Call `runtime.shutdown()` yourself only when embedding Axon in a process you
own.
