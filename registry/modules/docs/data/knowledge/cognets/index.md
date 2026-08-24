---
title: Cognets
description: A cognitive engine — the loop, the world model, and the instrumentation for building minds.
---

# Cognets

A cognet is a cognitive engine: the loop, the world model, the clock, and the
instrumentation you need to build a mind — with no opinion about what that mind is for.

A game engine gives you a frame loop, an entity system, and a profiler, then gets out of
the way. Nobody ships the engine as the product; they ship the game. This is the same
bargain, one domain over. You get a wake loop, an entity-component world, a phase clock,
and a flame graph of every thought. Whether you build a coding agent, a research
pipeline, a control loop, or an embodied butler is entirely yours.

The engine can afford to have no opinion because of what a cognet is denied.

It has no filesystem. No network. No clock of its own. It cannot read its own
configuration, cannot write to its own log, and cannot discover anything about the
machine it runs on.

It has ten verbs.

**Stimuli in, actions or data out.** Everything else — what a stimulus physically is,
what an action does to the world, whether either involves a language model — lives on the
other side of a boundary the cognet cannot see across.

Which is why the same engine runs a chat agent, a 120Hz perception stack, and a robot.

## Create one

```bash
axon cognet init my-cognet
cd my-cognet
```

That scaffolds the project, installs the framework, and generates
`.cognet/globals.d.ts` — the ambient authoring surface that types `loop`, `kernel`,
`phase`, and `system` in your editor.

## What a brain looks like

Three files. The middle one is the mind:

```bash
my-cognet/
├── plugins/           # lifecycle hooks: boot, wake, tick, shutdown
├── src/
│   ├── main.ts        # the brain — declares loop()      (scaffolded)
│   └── state.ts       # resident memory, shaped however you like
├── cognet.config.ts   # identity and ABI version         (scaffolded)
└── package.json       #                                  (scaffolded)
```

`init` writes the marked files. `src/state.ts` and `plugins/` are conventions, not
requirements — add them when you want somewhere to put resident memory or lifecycle
hooks. A cognet with only `main.ts` is a complete cognet.

`src/main.ts` is a raw script with typed ambient globals. It runs once at load and
declares exactly one loop:

```ts
loop(async ({ stimuli, signal, stop }) => {
    await phase("sense", async () => {
        // fold what's new into your own model
    })

    await phase("think", async () => {
        // your strategy. the kernel has no opinion past this line.
    })

    await phase("act", async () => {
        // effects leave through exactly two doors:
        //   kernel.output(type, data)  — emit a fact
        //   kernel.run(code)           — request execution
    })

    stop()   // nothing pending — this wake is over, the brain stays warm
})
```

That's a cognet. `phase()` names a stage and times it. `stop()` ends the wake. Module
scope is the brain's resident RAM: alive across wakes, rebuildable from the log, and lost
without consequence on `kill -9`.

## Two ways to be alive

A cognet declares how it is triggered, and that single choice is the difference between a
chat agent and a control loop.

**Invocation** — the brain wakes when a stimulus arrives. A coding agent, a support
agent, anything conversational: it sleeps until there's something to think about.

```ts
export default defineCognet({
    name: "reviewer",
    abi: "10",
    mode: { kind: "invocation" },
})
```

**Continuous** — the brain wakes on a clock, whether or not anything arrived. A
perception stack, a controller, an embodied agent that must keep acting whether or not
the world spoke to it.

```ts
export default defineCognet({
    name: "gait",
    abi: "10",
    mode: { kind: "continuous" },
})
```

Note what isn't there: a rate. The declaration says *how* this brain wakes, never *how
often*. The rate lives in the brain's own plugin:

```ts
// plugins/clock.ts — in the cognet
export default definePlugin(({ hooks }) => {
    hooks.on("boot", () => {
        setInterval(() => void kernel.wake(), 8)   // 125Hz
    })
})
```

The body only ever emits stimuli, and never wakes anything:

```ts
// server/plugins/body.ts — in the agent
setInterval(async () => {
    await axon.stim("cognet:stimulus:field", { ... })
}, 8)
```

Two different quantities. How fast frames arrive is a property of a sensor; how often it
is worth thinking about them is a property of a mind. Keeping them apart is what makes
bodies swappable — one that drove a specific brain would need rewriting whenever the
brain changed — and it is the only answer that survives composition, where two sensors at
different rates have equal claim to being "the" rate.

**Every tick wakes**, however long the last one is still taking. Wakes overlap, and they
share the cognet's module scope — a mind that stops sensing while it thinks cannot be
interrupted, and a stimulus is delivered once and then dropped, so a skipped tick is not
a late tick but a tick that never heard.

Coordinating that overlap is the cognet's own business: a flag in resident state is how
you avoid calling the engine twice. The kernel supplies no primitive for it, because any
primitive would be the runtime having an opinion about how cognition is organised.

Both modes call the same wake machinery, and the loop body doesn't change shape between
them. An empty stimuli diff is the ordinary steady state for a continuous cognet, not an
edge case it has to special-case.

## The engine is not about LLMs

Inference is one verb of ten:

| Verb | What it does |
|---|---|
| `kernel.output(type, data)` | Unmediated emission. Commits to the log; never refuses. |
| `kernel.run(code)` | Mediated request. The kernel executes and commits both sides. |
| `kernel.stream(req)` | Inference. |
| `kernel.scope()` | The tool surface currently available. |
| `kernel.base()` | The agent's standing identity text. |
| `kernel.emit(type, data)` | Its own telemetry. `cognet:*` only, refused otherwise. |
| `kernel.store` | Private key/value state, plus a read-only view of the episodic log. |
| `kernel.wake()` | Wake itself — the brain's own rhythm. Continuous cognets only. |
| `kernel.clock()` | A snapshot of that rhythm: wakes admitted since boot. |
| `kernel.models` | Absolute paths to the weights this cognet declared. |

Not the axis the others hang off — one row. A cognet that never calls `stream()` is still
a cognet: same loop, same clock, same telemetry, same durable record.

Here is a classical controller, with no model anywhere in it:

```ts
let integral = 0
let previous = 0

loop(async ({ stop }) => {
    const { error, dt } = await phase("sense", async () => readSensor())

    const command = await phase("compute", async () => {
        integral += error * dt
        const derivative = (error - previous) / dt
        previous = error
        return Kp * error + Ki * integral + Kd * derivative
    })

    await phase("actuate", async () => {
        await kernel.output("cognet:output:field", {
            reading: { value: command, unit: "throttle" },
        })
    })

    stop()
})
```

Same `loop()`. Same `phase()`. Same telemetry, same flame graph, same durability. The
only difference between that and a language-model agent is what happens inside `think`.

That is what makes this a substrate rather than an agent framework. You can put a
perception stack in here and run it with models entirely out of the hot loop, or build a
pipeline where three different models each do a job a brain needs done, or write
something with no learned component at all.

## Where a cognet sits

A cognet is one layer of three, and it's the only one that thinks.

| Layer | What it owns |
|---|---|
| **Axon** | identity, policy, ownership, the deployable handle |
| **Cognet** | the cognition — just code, against a kernel |
| **Body** | ROS, a simulator, an HTTP endpoint, a microphone |

Robotics middleware like ROS is a nervous system: it moves messages between drivers,
sensors, and actuators, and does that well. It has no opinion about the entity those
parts belong to — who owns it, what it is permitted to do, what it decided and why. Axon
is that outer layer. A module bridges ROS into it: topics become stimuli, actions become
effects, and the cognet — which knows about neither — thinks.

The same holds with no hardware anywhere. A cognet reviewing code has exactly the same
relationship to its environment as one driving a servo. Neither can tell which it is.

## The boundary is enforced, not agreed

Axon already treats model-authored code as untrusted: the capsule can request, only the
kernel can take. Cognets extend that inversion one ring further in. **The cognet is the
cognition, and the kernel protects the user's resources from it with equal severity** —
not because your brain is malicious, but because a boundary that only holds for
well-behaved code isn't a boundary.

A cognet cannot commit to the session log; it emits, and the kernel writes on its behalf.
It cannot read kernel telemetry, only entries. It cannot touch the filesystem except by
asking the kernel to run code in a capsule the kernel alone constructs, under the agent's
policy.

Strip all of that away and what remains is portable. A mind that never learned what kind
of world it was in doesn't need porting when the world changes.

## Who this is for

Most people building on Axon never open a cognet. They write an agent — identity, tools,
policy — and the runtime handles cognition. That's the point of the platform.

This section is for the people who want to build the cognition itself: researchers,
robotics engineers, anyone who looks at an agent loop and wants to replace it rather than
configure it. The material stays engineer-facing. A cognitive engine doesn't have a
beginner mode.

If you're building an agent, start with [Agent](/docs/v2/agent). If you want to program
the mind inside one, keep reading.

## Why it's public

Axon began as two projects — a cognitive engine and an agent runtime — that turned out to
be one system written twice. Collapsing them produced this boundary, which is why it sits
where it does rather than where a design document would have put it.

It was meant to stay private. It isn't, because the platform is the product: every layer
people can build on directly is a layer that compounds.

## Start here

**[The Kernel Contract](/docs/v2/cognets/engine/kernel-contract)** — the ten verbs in
full, and everything a cognet structurally cannot do. Read this first; every page after
it is a consequence.

**[The Loop](/docs/v2/cognets/engine/loop)** — `loop`, `tick`, `phase`, `system`, and the
world clock.

**[The World](/docs/v2/cognets/engine/world)** — the entity-component model, and why
cognition is shaped like a game world.

**[Memory](/docs/v2/cognets/engine/memory)** — the log-shaped mind, and why cold boot and
a steady-state tick are the same operation.

**[Anatomy of zero](/docs/v2/cognets/building/zero)** — the reference cognet, read in
full. The one you'll clone.

**[Cognition Beyond the LLM](/docs/v2/cognets/building/beyond-llm)** — control loops,
perception stacks, embodied agents, simulated organisms.
