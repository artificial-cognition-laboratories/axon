---
title: Testing
---

# Testing

Agents look untestable. The model is nondeterministic, the loop is asynchronous, the
side effects land on a real filesystem — so most teams either don't test their agents,
or test a pile of mocks that proves nothing about production.

Axon's answer: **everything is real except the model.** The test harness boots your
full runtime — real kernel, real capsule, real tools, real policy, real session log —
against your actual `axon.config.ts`. The only substitution is inference. There is
nothing else to mock, because everything else is deterministic.

```ts
it("answers a greeting", async () => {
    const runtime = await Axon({
        blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
    })

    const result = await runtime.axon.request("hello")
    expect(result.text).toBe("hi there")

    await runtime.shutdown()
})
```

That's not a unit test of a function. That's your agent — booted, invoked through its
public API, shut down. The same runtime that serves production requests just ran on
your machine in milliseconds, for free.

## Script the model

`Mock()` replaces inference with a script you write. Map patterns to replies, and the
loop behaves exactly as if the model had said it:

```ts
import { Mock, run } from "@arcforge/engines/mock"

// single reply — matched against the last user message
engine: Mock({ "sprint status": "Two issues remain in review." })

// a sequence — one step per loop tick, in order
engine: Mock({
    "review the file": [
        run(`fs.read("src/index.ts")`),   // tick 1: the "model" acts
        "The file looks correct.",         // tick 2: it reads the result, then speaks
    ],
})
```

`run()` is the interesting one: the scripted step executes real code in the real
capsule, under your real policy. You're not simulating a tool call — the tool runs, the
result enters the session log, and the next tick sees it, exactly as in production. You
choreograph the model's decisions; the entire machinery underneath them is live.

This means you can deterministically test the parts of agent behaviour that are usually
untestable: multi-step flows, tool failure handling, policy rejections, what lands in
the trace.

## What to test

**Tools** — plain TypeScript, called directly through `runtime.axon.tools.*`. Assert
on return shapes and guard conditions. Test the logic you own, not the external
services it wraps.

**Prompts** — render with `runtime.axon.prompt()` and assert on the output. Catches
broken interpolation, missing sections, stale variable names — the regressions that
silently degrade agent quality.

**Flows** — invoke through the public API and assert on what actually happened: the
result text, the entries in `result.entries`, the session log. Fire hooks with
`callHook()` and assert a reply came back. This is the primary integration test — the
module emits an event, your plugin handles it, the agent runs, the trace proves it.

**Failure behaviour** — the runtime fails loudly, and you can assert on that too:

```ts
it("rejects when no engine is configured", async () => {
    const runtime = await Axon()
    await expect(runtime.axon.request("hello")).rejects.toThrow(/No Engine Configured/)
    await runtime.shutdown()
})
```

What you don't test is the model. It isn't yours, it isn't deterministic, and no
assertion about its prose survives a model upgrade. Test the machine around it — that's
the part with correct answers, and it's the part you built.

## Agents and modules

**Testing an agent** — you own the config and the source. Boot the harness, test your
tools, prompts, and flows. Test files live in `tests/` at the agent root.

**Testing a module** — modules have no standalone runtime; tests run from inside an
agent with the module installed. Same harness, different assertions: the tool namespace
appeared, the prompts render, the hooks trigger the right behaviour in the host.

## Where to go

- [Agent tests](/docs/v2/agent/tests) — the full reference for testing agents
- [Module tests](/docs/v2/modules/tests) — the full reference for testing modules
- [Mock()](/docs/v2/agent/engines/mock) — the complete Mock engine API
